/**
 * Derives the list of subagents still working from the rendered message list.
 *
 * A background agent's `tool_use` result arrives the moment it is launched, so
 * "is it done?" comes from `subagentState.isComplete` (transcript-derived
 * server-side), never from the presence of a result.
 */

import type { ChatMessage } from '../types/types';

export type RunningBackgroundAgent = {
  toolId: string;
  /** `subagent_type`, e.g. `general-purpose` or `Explore`. */
  agentType: string;
  description: string;
  /** When the agent was spawned, used for the elapsed-time readout. */
  startedAt: Date;
  toolCount: number;
};

const parseToolInput = (toolInput: unknown): Record<string, unknown> => {
  if (typeof toolInput !== 'string') {
    return (toolInput as Record<string, unknown>) ?? {};
  }

  try {
    return JSON.parse(toolInput) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const readString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value : null
);

export function getRunningBackgroundAgents(messages: ChatMessage[]): RunningBackgroundAgent[] {
  const running: RunningBackgroundAgent[] = [];

  for (const message of messages) {
    if (!message.isSubagentContainer || !message.subagentState || message.subagentState.isComplete) {
      continue;
    }

    const input = parseToolInput(message.toolInput);
    running.push({
      toolId: message.toolId ?? `${running.length}`,
      agentType: readString(input.subagent_type) ?? 'Agent',
      description: readString(input.description) ?? 'Running task',
      startedAt: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp ?? Date.now()),
      toolCount: message.subagentState.childTools.length,
    });
  }

  return running;
}

/** Formats an elapsed duration the way the CLI status line does (`16m 14s`). */
export function formatElapsed(fromMs: number, nowMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
