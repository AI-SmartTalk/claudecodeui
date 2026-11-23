import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { createKanbanAgentRunner } from '@/modules/kanban/services/kanban-agent.service.js';
import { setKanbanAgentRunner } from '@/modules/kanban/services/kanban.service.js';
import { providerModelsService, sessionSynchronizerService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';

/** How many trailing transcript messages are read to find the agent's last reply. */
const LAST_REPLY_WINDOW = 40;

/** Pause between reads of a transcript the file watcher has not indexed yet. */
const TRANSCRIPT_RETRY_DELAY_MS = 1500;
const TRANSCRIPT_READ_ATTEMPTS = 3;

async function readLastReplyFromHistory(sessionId: string): Promise<string | null> {
  const history = await sessionsService.fetchHistory(sessionId, { limit: LAST_REPLY_WINDOW, offset: 0 });
  const reply = [...history.messages].reverse().find((message) => (
    message.kind === 'text' && message.role === 'assistant' && typeof message.content === 'string' && message.content.trim()
  ));
  return reply?.content ?? null;
}

/**
 * Finds a Claude transcript by its provider session id. Claude names the file
 * after the session and files it under a folder derived from the cwd; the
 * derivation has edge cases (symlinked /tmp, dots), so the folders are searched
 * rather than recomputed.
 */
async function findClaudeTranscript(providerSessionId: string): Promise<string | null> {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  let folders: string[];
  try {
    folders = await readdir(projectsRoot);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const candidate = path.join(projectsRoot, folder, `${providerSessionId}.jsonl`);
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Not in this folder.
    }
  }
  return null;
}

/**
 * The agent's final reply in a session. Claude history is read through the
 * transcript path the file watcher records, which can lag the end of the run;
 * so the read is retried, and a transcript still unknown is indexed directly.
 */
async function readLastAssistantMessage(sessionId: string): Promise<string | null> {
  for (let attempt = 0; attempt < TRANSCRIPT_READ_ATTEMPTS; attempt += 1) {
    const reply = await readLastReplyFromHistory(sessionId);
    if (reply) {
      return reply;
    }
    const session = sessionsDb.getSessionById(sessionId);
    if (session?.provider === 'claude' && !session.jsonl_path && session.provider_session_id) {
      const transcript = await findClaudeTranscript(session.provider_session_id);
      if (transcript) {
        await sessionSynchronizerService.synchronizeProviderFile('claude', transcript);
        const indexedReply = await readLastReplyFromHistory(sessionId);
        if (indexedReply) {
          return indexedReply;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_RETRY_DELAY_MS));
  }
  return null;
}

/**
 * Wires the Kanban agent runner to the real providers, sessions and run
 * registry, then recovers cards a previous process left mid-run.
 *
 * Called by the server at boot, alongside the scheduled-message dispatcher,
 * because both need the provider runtime that only exists once the server is up.
 */
export async function initializeKanbanAgents(runtime: ProviderRuntimeGateway): Promise<void> {
  const runner = createKanbanAgentRunner({
    runTurn: (input) => runDetachedChatTurn(input, { runtime }),
    async abortSession(sessionId) {
      const run = chatRunRegistry.getRun(sessionId);
      if (!run || run.status !== 'running') {
        return false;
      }
      // Same shape as the chat's `chat.abort`: abort, then emit the terminal complete.
      const aborted = await runtime.abort(run.provider, sessionId);
      chatRunRegistry.completeRun(sessionId, { exitCode: aborted ? 0 : 1, aborted: true });
      return aborted;
    },
    isSessionBusy: (sessionId) => chatRunRegistry.isProcessing(sessionId),
    sessionExists: (sessionId) => Boolean(sessionsDb.getSessionById(sessionId)),
    createSession: (provider, projectPath, title) =>
      sessionsService.createAppSession(provider as LLMProvider, projectPath, title).sessionId,
    async getDefaultModel(provider) {
      const models = await providerModelsService.getDefaultModels();
      return models[provider as LLMProvider] ?? null;
    },
    readLastAssistantMessage,
    getProjectPath: (projectId) => projectsDb.getProjectPathById(projectId),
  });

  setKanbanAgentRunner(runner);
  await runner.recover();
}
