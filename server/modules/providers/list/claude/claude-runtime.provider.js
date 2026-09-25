/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import { ClaudeLiveProcess } from '@/modules/providers/list/claude/claude-live-process.provider.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT
} from '@/modules/providers/list/claude/claude-models.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

// One live CLI process per conversation, keyed by the app session id (or the
// provider id once captured, for callers that pass none). Each entry is
// `{ process: ClaudeLiveProcess, state }`; see queryClaudeSDK.
const liveProcesses = new Map();
const pendingToolApprovals = new Map();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

// Passed to the spawned CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: once its stdin
// closes, how long it keeps waiting for still-running background work before killing
// it. Also the silence backstop for a held process whose only remaining work is
// deferred (a scheduled wake-up), so an abandoned session cannot leak a process.
const BG_WAIT_CEILING_MS = 30 * 60 * 1000;

// Silence tolerated while background tasks are still running. A background shell
// reports nothing until it exits, and closing stdin under it is what used to cut
// long jobs short, so this only bounds a task that never ends.
const BACKGROUND_TASK_SILENCE_CEILING_MS = 6 * 60 * 60 * 1000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Ultracode is a session-scoped setting rather than an SDK effort level: it pairs xhigh
// effort with standing dynamic-workflow orchestration, and the CLI only honours it when
// Workflows are enabled. The catalog offers it as an effort choice for the picker, so the
// selection is translated back into the two options the SDK actually understands here.
const ULTRACODE_SDK_EFFORT = 'xhigh';

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_PREDEFINED_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

/**
 * Writes the resolved effort choice onto the SDK options, expanding `ultracode` into the
 * xhigh effort level plus the session-scoped settings it requires.
 * @param {Object} sdkOptions - SDK options being built
 * @param {string|undefined} resolvedEffort - Catalog-validated effort selection
 */
function applyClaudeEffort(sdkOptions, resolvedEffort) {
  if (!resolvedEffort) {
    return;
  }

  if (resolvedEffort !== CLAUDE_ULTRACODE_EFFORT) {
    sdkOptions.effort = resolvedEffort;
    return;
  }

  sdkOptions.effort = ULTRACODE_SDK_EFFORT;
  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    ultracode: true,
    enableWorkflows: true
  };
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort, resumeAnchorId, resumeFromScratch } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  // Session-state events tell a live process when the CLI has truly gone idle —
  // a background agent keeps it "running" after the turn's `result`.
  sdkOptions.env = {
    ...process.env,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(BG_WAIT_CEILING_MS),
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1'
  };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  // When nothing resolves the option stays unset on purpose: the SDK then falls back to the
  // binary it ships, which beats handing it a bare `claude` that raw spawn can never launch.
  const claudeExecutablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (claudeExecutablePath) {
    sdkOptions.pathToClaudeCodeExecutable = claudeExecutablePath;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;

  applyClaudeEffort(sdkOptions, resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
  ));

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The SDK resumes with the provider-native session id, never the app id.
  // `resumeFromScratch` is set when the very first prompt of a conversation was
  // edited: there is nothing before it to resume through, so the turn has to
  // start the conversation over instead.
  if (providerSessionId && !resumeFromScratch) {
    sdkOptions.resume = providerSessionId;

    // Editing an already-sent message re-runs the conversation truncated just
    // before it. `resumeSessionAt` is inclusive of the uuid it names, so the
    // caller resolves the last row to KEEP and passes that — never the edited
    // turn itself, which would leave the original prompt in context.
    if (resumeAnchorId) {
      sdkOptions.resumeSessionAt = resumeAnchorId;
    }
  }

  return sdkOptions;
}

/**
 * Serializes the spawn options a follow-up turn must share to reuse a live
 * process. Anything else (a new model, effort, or permission mode) is only
 * honoured by a process spawned with it.
 * @param {Object} sdkOptions - Options the process would be spawned with
 * @returns {string} Comparable signature
 */
function describeProcessOptions(sdkOptions) {
  return JSON.stringify({
    cwd: sdkOptions.cwd ?? null,
    model: sdkOptions.model ?? null,
    effort: sdkOptions.effort ?? null,
    settings: sdkOptions.settings ?? null,
    permissionMode: sdkOptions.permissionMode ?? null,
    allowedTools: [...(sdkOptions.allowedTools || [])].sort(),
    disallowedTools: [...(sdkOptions.disallowedTools || [])].sort()
  });
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * True for the user bubble the SDK echoes for a subagent's own prompt.
 *
 * Subagent traffic carries `parent_tool_use_id`, so this echo lands in the main
 * thread and stacks a second copy of the prompt right below the Agent tool card
 * that already displays it. It also disappears on reload, because the transcript
 * keeps that turn in the subagent's sidechain rather than the session file.
 * @param {Object} message - Normalized message about to be sent to the client
 * @returns {boolean}
 */
export function isSubagentPromptEcho(message) {
  return Boolean(message?.parentToolUseId) && message.role === 'user' && message.kind === 'text';
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @typedef {Object} TokenBudget
 * @property {number} used
 * @property {number} total
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheCreationTokens]
 * @property {number} [cacheTokens]
 * @property {{ input: number, output: number }} breakdown
 */

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage) {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Extracts the session's context-window usage from an SDK stream message.
 *
 * Only assistant messages describe the context window: each one reports the
 * prompt its own request carried. The turn-ending `result` is deliberately not
 * a source here — see `extractCumulativeTokenBudget`.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  if (sdkMessage.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (sdkMessage.type !== 'assistant') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  return buildTokenBudget(messageUsage);
}

/**
 * Last-resort budget read from a turn's `result` message.
 *
 * `result.usage` and `result.modelUsage` are the turn's *bill*: every request
 * the turn made, summed, including each subagent's. A turn that made four
 * requests therefore reports roughly four times the context the conversation
 * actually holds, so publishing it made the counter leap at the end of a turn
 * and fall back on the next assistant message — worst with subagents running,
 * whose requests inflate the sum without ever entering this session's context.
 *
 * It is still the only usage an SDK build that reports none per assistant
 * message ever emits, so it stays available for the caller to use when a turn
 * produced no assistant budget at all.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractCumulativeTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    return buildTokenBudget(sdkMessage.usage);
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Builds the SDK user message for one turn.
 *
 * Always an SDKUserMessage record rather than a bare string: a string prompt
 * makes the SDK flag the query as single-turn and close stdin the moment the
 * turn's `result` arrives, which kills the CLI's background tasks. Plain text
 * turns carry string content; turns with image attachments carry the prompt
 * text plus one base64 `image` block per attachment (read from the global
 * `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Object>} SDKUserMessage record for the turn
 */
async function buildPromptMessage(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return {
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  };
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Forwards one SDK stream message to the run currently attached to the
 * conversation's process.
 * @param {Object} message - SDK stream message
 * @param {Object} turn - `{ writer, sessionSummary }` of the attached run
 * @param {Object} state - Per-process session bookkeeping (see queryClaudeSDK)
 * @param {Object} context - Provider-scoped lookups
 * @param {Function} onProviderSessionId - Called once a brand-new session's id is known
 */
function forwardStreamMessage(message, turn, state, context, onProviderSessionId) {
  const { writer } = turn;

  // A brand-new session only learns its provider id from the stream.
  if (message.session_id && !state.capturedSessionId) {
    state.capturedSessionId = message.session_id;
    onProviderSessionId(state.capturedSessionId);

    if (typeof writer.setSessionId === 'function') {
      writer.setSessionId(state.capturedSessionId);
    }

    // Send session-created event only once for sessions with nothing to resume
    if (!state.providerSessionId && !state.sessionCreatedSent) {
      state.sessionCreatedSent = true;
      writer.send(createNormalizedMessage({ kind: 'session_created', newSessionId: state.capturedSessionId, sessionId: state.capturedSessionId, provider: 'claude' }));
    }
  }

  // Transform and normalize message via adapter
  const transformedMessage = transformMessage(message);
  const sid = state.capturedSessionId || state.sessionId || null;
  const normalized = context.normalizeMessage(transformedMessage, sid);
  for (const msg of normalized) {
    // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
    if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
      msg.parentToolUseId = transformedMessage.parentToolUseId;
    }
    if (isSubagentPromptEcho(msg)) {
      continue;
    }
    writer.send(msg);
  }

  // Extract and send token budget updates from assistant usage payloads,
  // falling back to the turn's cumulative bill only for SDK builds that
  // report no per-assistant usage at all.
  const tokenBudgetData = extractTokenBudget(message)
    || (state.assistantBudgetSent ? null : extractCumulativeTokenBudget(message));
  if (tokenBudgetData) {
    if (message.type === 'assistant') {
      state.assistantBudgetSent = true;
    }
    writer.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: sid, provider: 'claude' }));
  }
  // Each turn gets its own chance to report per-assistant usage.
  if (message.type === 'result') {
    state.assistantBudgetSent = false;
  }
}

/**
 * Surfaces a failed run to its client: the error row, the terminal `complete`
 * when the turn has not reported one yet, and the failure notification.
 * @param {unknown} error - What went wrong
 * @param {Object} turn - `{ writer, sessionSummary }` of the run to report to
 * @param {Object} state - Session ids known so far
 * @param {Object} context - Provider-scoped lookups
 * @param {{ terminal: boolean }} options - Whether to end the run with `complete`
 */
async function reportRunError(error, turn, state, context, { terminal }) {
  console.error('SDK query error:', error);
  const { writer, sessionSummary } = turn;
  const eventSessionId = state.capturedSessionId || state.sessionId || null;

  // Check if Claude CLI is installed for a clearer error message
  const installed = await context.isProviderInstalled();
  const errorContent = !installed
    ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
    : error?.message || String(error);

  writer.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: eventSessionId, provider: 'claude' }));
  if (terminal) {
    writer.send(createCompleteMessage({ provider: 'claude', sessionId: eventSessionId, exitCode: 1 }));
  }
  notifyRunFailed({
    userId: writer?.userId || null,
    provider: 'claude',
    sessionId: state.sessionId || state.capturedSessionId || null,
    sessionName: sessionSummary,
    error
  });
}

/**
 * Tells the run that asked for a turn how it ended.
 * @param {Object} turn - `{ writer, sessionSummary }` of the run
 * @param {Object} settlement - Outcome reported by the live process
 * @param {Object} state - Per-process session bookkeeping
 * @param {Object} context - Provider-scoped lookups
 */
async function reportTurnSettlement(turn, settlement, state, context) {
  const { writer, sessionSummary } = turn;
  // Events carry the provider id (the gateway writer remaps it); notifications
  // are app-facing and carry the app session id.
  const eventSessionId = state.capturedSessionId || state.sessionId || null;
  const notification = {
    userId: writer?.userId || null,
    provider: 'claude',
    sessionId: state.sessionId || state.capturedSessionId || null,
    sessionName: sessionSummary
  };

  switch (settlement.outcome) {
    case 'completed':
      writer.send(createCompleteMessage({ provider: 'claude', sessionId: eventSessionId, exitCode: 0 }));
      notifyRunStopped({ ...notification, stopReason: 'completed' });
      return;
    case 'aborted':
      // The abort path already sent this turn's terminal `complete` (aborted: true).
      notifyRunStopped({ ...notification, stopReason: 'aborted' });
      return;
    case 'failed':
      await reportRunError(settlement.error, turn, state, context, { terminal: true });
      return;
    default:
      // Superseded: the process that replaced this one owns every further event.
      return;
  }
}

/**
 * Runs one turn of a Claude conversation and resolves when that turn ends.
 *
 * A conversation keeps a single CLI process while it has work in flight —
 * background agents, or a turn still finishing after the app reported the
 * previous one done. A follow-up turn is written to that process's stdin rather
 * than spawning a concurrent `--resume`: two processes on one transcript fork
 * the conversation, and the user's latest message silently drops out of what
 * Claude sees. A process is spawned only when none is live, or when the turn
 * needs options the live one was not started with, and then the old one is
 * stopped first.
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - Writer for this run's events
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws, context) {
  const { sessionId, sessionSummary } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  const turn = { writer: ws, sessionSummary };

  // Per-process session bookkeeping, shared by every turn the process serves.
  const state = {
    sessionId: sessionId || null,
    providerSessionId,
    // Provider-native id as the SDK reports it (starts as the resume id, or is
    // captured from the stream for brand-new sessions).
    capturedSessionId: providerSessionId,
    sessionCreatedSent: false,
    assistantBudgetSent: false
  };

  let sdkOptions;
  let promptMessage;
  try {
    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    let effortModels = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
    });
    promptMessage = await buildPromptMessage(command, options.images, options.files, options.cwd);
  } catch (error) {
    await reportRunError(error, turn, state, context, { terminal: true });
    return;
  }

  const signature = describeProcessOptions(sdkOptions);
  // An edited message resumes the transcript partway, which only a process
  // spawned for it can do.
  const needsFreshProcess = Boolean(options.resumeAnchorId || options.resumeFromScratch);
  const live = sessionId ? liveProcesses.get(sessionId) : undefined;

  if (live && !needsFreshProcess && live.process.accepts(signature)) {
    if (live.state.capturedSessionId && typeof ws.setSessionId === 'function') {
      ws.setSessionId(live.state.capturedSessionId);
    }
    await live.process.runTurn(promptMessage, turn);
    return;
  }

  if (live) {
    // Never two processes on one transcript: the old one is stopped, its
    // background work included, before a replacement resumes the conversation.
    await live.process.stop();
  }

  let entry = null;
  // Permission prompts and notifications belong to whichever run is attached now.
  const currentTurn = () => entry?.process.turn ?? turn;
  const appSessionId = () => state.sessionId || state.capturedSessionId || null;

  const emitNotification = (event) => {
    const { writer } = currentTurn();
    notifyUserIfEnabled({
      userId: writer?.userId || null,
      writer,
      event
    });
  };

  try {
    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: appSessionId(),
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: currentTurn().sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${appSessionId() || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, toolContext) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      // The prompt, its retraction and its resolution all go to the run that
      // was attached when the tool asked.
      const { writer, sessionSummary: sessionName } = currentTurn();
      const eventSessionId = state.capturedSessionId || state.sessionId || null;
      const requestId = createRequestId();
      writer.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: eventSessionId, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: appSessionId(),
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${appSessionId() || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: toolContext?.signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: appSessionId(),
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          writer.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: eventSessionId, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      // A client answered. Announce it on the run stream so the replay buffer
      // and every other attached tab drop the prompt — resolving happens over
      // the inbound socket only, so without this a mid-run page refresh
      // replays the `permission_request` with nothing to retract it and the
      // already-answered prompt resurrects.
      writer.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: eventSessionId, provider: 'claude' }));

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    const register = (key) => {
      if (key && entry) {
        liveProcesses.set(key, entry);
      }
    };

    const liveProcess = new ClaudeLiveProcess({
      signature,
      start: (openPrompt) => {
        try {
          return query({ prompt: openPrompt(), options: sdkOptions });
        } catch (hookError) {
          // Older/newer SDK versions may not accept hook shapes yet.
          // Keep notification behavior operational via runtime events even if hook registration fails.
          console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
          delete sdkOptions.hooks;
          return query({ prompt: openPrompt(), options: sdkOptions });
        }
      },
      callbacks: {
        onMessage: (message, attachedTurn) => forwardStreamMessage(message, attachedTurn, state, context, (capturedId) => {
          // Callers without an app session id address the process by provider id.
          if (!state.sessionId) {
            register(capturedId);
          }
        }),
        onTurnSettled: (settledTurn, settlement) => reportTurnSettlement(settledTurn, settlement, state, context),
        onBackgroundReport: (_result, attachedTurn) => {
          notifyBackgroundWorkCompleted({
            userId: attachedTurn.writer?.userId || null,
            provider: 'claude',
            sessionId: appSessionId(),
            sessionName: attachedTurn.sessionSummary
          });
        },
        // A process that fails with no turn waiting already reported its turns
        // complete, so it surfaces the error without a second terminal event.
        onProcessError: (error, attachedTurn) => reportRunError(error, attachedTurn, state, context, { terminal: false }),
      },
      idleCeilingMs: BG_WAIT_CEILING_MS,
      busyCeilingMs: BACKGROUND_TASK_SILENCE_CEILING_MS,
    }, turn);

    entry = { process: liveProcess, state };
    register(state.sessionId || state.capturedSessionId);
    void liveProcess.ended.then(() => {
      for (const [key, candidate] of liveProcesses) {
        if (candidate === entry) {
          liveProcesses.delete(key);
        }
      }
    });
  } catch (error) {
    await reportRunError(error, turn, state, context, { terminal: true });
    return;
  }

  console.log('Starting Claude CLI process for session:', state.capturedSessionId || 'NEW');
  await entry.process.runTurn(promptMessage, turn);
}

/**
 * Stops the turn in flight for a conversation. Its CLI process stays up, so
 * background agents keep running and the next message reuses it.
 * @param {string} sessionId - Session identifier
 * @returns {Promise<boolean>} True if a live process was interrupted, false if none
 */
async function abortClaudeSDKSession(sessionId) {
  const live = liveProcesses.get(sessionId);

  if (!live) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  console.log(`Aborting SDK session: ${sessionId}`);
  return live.process.interrupt();
}

/**
 * Checks if a conversation currently has a live CLI process
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  return liveProcesses.has(sessionId);
}

/**
 * Gets the ids of every conversation with a live CLI process
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return Array.from(liveProcesses.keys());
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const writer = liveProcesses.get(sessionId)?.process.turn?.writer;
  if (!writer?.updateWebSocket) return false;
  writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  extractTokenBudget,
  extractCumulativeTokenBudget
};
