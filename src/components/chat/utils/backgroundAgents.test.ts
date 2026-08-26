import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import { formatElapsed, getRunningBackgroundAgents } from './backgroundAgents';

const STARTED_AT = new Date('2026-07-22T10:00:00.000Z');

const subagentMessage = (
  description: string,
  isComplete: boolean,
  toolCount: number,
): ChatMessage => ({
  type: 'assistant',
  timestamp: STARTED_AT,
  isToolUse: true,
  toolName: 'Agent',
  toolId: `tool-${description}`,
  toolInput: JSON.stringify({ description, subagent_type: 'general-purpose' }),
  isSubagentContainer: true,
  subagentState: {
    childTools: Array.from({ length: toolCount }, (_unused, index) => ({
      toolId: `child-${index}`,
      toolName: 'Read',
      toolInput: {},
      toolResult: null,
      timestamp: STARTED_AT,
    })),
    currentToolIndex: toolCount - 1,
    isComplete,
  },
});

test('only subagents that have not returned are listed', () => {
  const running = getRunningBackgroundAgents([
    subagentMessage('finished', true, 5),
    subagentMessage('still working', false, 51),
    { type: 'assistant', timestamp: STARTED_AT, content: 'plain text' },
  ]);

  assert.deepEqual(
    running.map((agent) => ({ description: agent.description, toolCount: agent.toolCount })),
    [{ description: 'still working', toolCount: 51 }],
  );
  assert.equal(running[0].agentType, 'general-purpose');
});

test('a launched agent with no tools yet still counts as running', () => {
  const running = getRunningBackgroundAgents([subagentMessage('just spawned', false, 0)]);
  assert.equal(running.length, 1);
  assert.equal(running[0].toolCount, 0);
});

test('elapsed time is formatted like the CLI status line', () => {
  const base = STARTED_AT.getTime();
  assert.equal(formatElapsed(base, base + 45_000), '45s');
  assert.equal(formatElapsed(base, base + 974_000), '16m 14s');
  assert.equal(formatElapsed(base, base + 7_500_000), '2h 5m');
  // A clock skew must not render a negative duration.
  assert.equal(formatElapsed(base, base - 5_000), '0s');
});
