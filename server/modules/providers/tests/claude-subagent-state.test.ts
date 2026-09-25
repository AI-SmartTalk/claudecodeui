import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { FetchHistoryResult } from '@/shared/types.js';

const SESSION_ID = 'session-under-test';
const AGENT_ID = 'a1b2c3d4e5f60718';
const TOOL_USE_ID = 'toolu_test_agent';
const PROJECT_PATH = '/tmp/project-under-test';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const jsonl = (entries: unknown[]): string => entries.map((entry) => JSON.stringify(entry)).join('\n');

/** Parent-session turns: the model launches an async agent and gets the launch ack back. */
const parentTranscript = (): string => jsonl([
  {
    sessionId: SESSION_ID,
    type: 'assistant',
    timestamp: '2026-07-22T10:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: TOOL_USE_ID,
        name: 'Agent',
        input: { description: 'Do the thing', subagent_type: 'general-purpose' },
      }],
    },
  },
  {
    sessionId: SESSION_ID,
    type: 'user',
    timestamp: '2026-07-22T10:00:01.000Z',
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: AGENT_ID },
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: TOOL_USE_ID,
        content: [{ type: 'text', text: 'Async agent launched successfully.' }],
      }],
    },
  },
]);

const agentToolTurn = jsonl([
  {
    type: 'assistant',
    timestamp: '2026-07-22T10:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_child', name: 'Read', input: {} }] },
  },
  {
    type: 'user',
    timestamp: '2026-07-22T10:00:03.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_child', content: 'file body' }] },
  },
]);

const agentFinalTurn = jsonl([{
  type: 'assistant',
  timestamp: '2026-07-22T10:00:04.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text: 'Here is my report.' }] },
}]);

const agentInterruption = jsonl([{
  type: 'user',
  timestamp: '2026-07-22T10:00:04.000Z',
  message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
}]);

/**
 * Runs `fetchHistory` against a throwaway ~/.claude tree holding one parent
 * session plus the given subagent transcript, and hands over the result.
 */
async function withClaudeHistory(
  agentTranscript: string,
  inspect: (history: FetchHistoryResult) => void,
  { laterParentTurns = [], limit = null }: { laterParentTurns?: unknown[]; limit?: number | null } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-subagent-'));
  const restoreHomeDir = patchHomeDir(tempDirectory);

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const projectDir = path.join(tempDirectory, '.claude', 'projects', 'encoded-project');
    await mkdir(path.join(projectDir, SESSION_ID, 'subagents'), { recursive: true });

    const sessionPath = path.join(projectDir, `${SESSION_ID}.jsonl`);
    const parentRows = [parentTranscript(), jsonl(laterParentTurns)].filter(Boolean).join('\n');
    await writeFile(sessionPath, parentRows, 'utf8');
    await writeFile(
      path.join(projectDir, SESSION_ID, 'subagents', `agent-${AGENT_ID}.jsonl`),
      agentTranscript,
      'utf8',
    );

    sessionsDb.createSession(SESSION_ID, 'claude', PROJECT_PATH, undefined, undefined, undefined, sessionPath);

    inspect(await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, { limit }));
  } finally {
    closeConnection();
    restoreHomeDir();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Runs `fetchHistory` like withClaudeHistory and returns the Agent row. */
async function withSubagentTranscript(
  agentTranscript: string,
  assertRow: (row: Record<string, unknown>) => void,
): Promise<void> {
  await withClaudeHistory(agentTranscript, ({ messages }) => {
    const row = messages.find((message) => message.kind === 'tool_use' && message.toolName === 'Agent');
    assert.ok(row, 'expected an Agent tool_use row in the normalized history');
    assertRow(row as Record<string, unknown>);
  });
}

test('an async agent still working reports as incomplete despite its launch ack', async () => {
  await withSubagentTranscript(agentToolTurn, (row) => {
    // The parent already holds a tool result ("async_launched"), so presence of a
    // result must not be what decides this.
    assert.ok(row.toolResult, 'the launch ack should still be attached');
    assert.equal((row.subagent as { status: string }).status, 'running');
  });
});

test('an async agent that returned its report reports as complete', async () => {
  await withSubagentTranscript(`${agentToolTurn}\n${agentFinalTurn}`, (row) => {
    assert.equal((row.subagent as { status: string }).status, 'completed');
  });
});

test('an interrupted agent reports as complete rather than running forever', async () => {
  await withSubagentTranscript(`${agentToolTurn}\n${agentInterruption}`, (row) => {
    assert.equal((row.subagent as { status: string }).status, 'completed');
  });
});

test('the history lists an agent still working', async () => {
  await withClaudeHistory(agentToolTurn, ({ runningBackgroundAgents }) => {
    assert.deepEqual(runningBackgroundAgents, [{
      toolId: TOOL_USE_ID,
      agentType: 'general-purpose',
      description: 'Do the thing',
      startedAt: '2026-07-22T10:00:00.000Z',
      toolCount: 1,
    }]);
  });
});

test('an agent launched before the requested page is still listed as running', async () => {
  // A long turn pushes the launching call out of the latest page; the composer
  // banner only sees that page, so the history has to name the agent itself.
  const laterParentTurns = Array.from({ length: 5 }, (_, index) => ({
    sessionId: SESSION_ID,
    type: 'assistant',
    timestamp: `2026-07-22T10:01:0${index}.000Z`,
    message: { role: 'assistant', content: [{ type: 'text', text: `Progress note ${index}` }] },
  }));

  await withClaudeHistory(agentToolTurn, ({ messages, runningBackgroundAgents }) => {
    assert.ok(!messages.some((message) => message.toolName === 'Agent'), 'the launch is outside the page');
    assert.deepEqual(runningBackgroundAgents?.map((agent) => agent.toolId), [TOOL_USE_ID]);
  }, { laterParentTurns, limit: 2 });
});

test('an agent that returned its report is not listed as running', async () => {
  await withClaudeHistory(`${agentToolTurn}\n${agentFinalTurn}`, ({ runningBackgroundAgents }) => {
    assert.deepEqual(runningBackgroundAgents, []);
  });
});
