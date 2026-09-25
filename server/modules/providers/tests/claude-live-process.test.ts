import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClaudeLiveProcess,
  type ClaudeQueryHandle,
  type ClaudeTurnSettlement,
} from '@/modules/providers/list/claude/claude-live-process.provider.js';
import type { AnyRecord } from '@/shared/types.js';

type Turn = { name: string };

/**
 * A scripted stand-in for the Claude CLI: the test decides what it emits, and
 * can inspect what reached its stdin and which control calls it received.
 */
function createFakeCli(options: { acknowledgeInterrupt?: boolean } = {}) {
  const outbound: AnyRecord[] = [];
  const stdin: AnyRecord[] = [];
  const calls: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let failure: unknown = null;
  let stdinClosed = false;

  const resume = () => {
    const pending = wake;
    wake = null;
    pending?.();
  };

  const handle: ClaudeQueryHandle = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (outbound.length > 0) {
          yield outbound.shift() as AnyRecord;
        }
        if (ended) {
          if (failure) {
            throw failure;
          }
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    interrupt() {
      calls.push(stdinClosed ? 'interrupt-after-stdin-closed' : 'interrupt');
      return options.acknowledgeInterrupt === false ? new Promise<void>(() => {}) : Promise.resolve();
    },
    close() {
      calls.push('close');
      ended = true;
      resume();
    },
  };

  return {
    stdin,
    calls,
    get stdinClosed() {
      return stdinClosed;
    },
    start(openPrompt: () => AsyncIterable<AnyRecord>): ClaudeQueryHandle {
      void (async () => {
        for await (const message of openPrompt()) {
          stdin.push(message);
        }
        stdinClosed = true;
        calls.push('stdin-closed');
      })();
      return handle;
    },
    emit(...messages: AnyRecord[]) {
      outbound.push(...messages);
      resume();
    },
    exit(error: unknown = null) {
      failure = error;
      ended = true;
      resume();
    },
  };
}

/** Lets queued stream messages and their reactions run. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function spawn(cli: ReturnType<typeof createFakeCli>, overrides: { interruptTimeoutMs?: number } = {}) {
  const settled: Array<{ turn: string; settlement: ClaudeTurnSettlement }> = [];
  const routed: Array<{ type: unknown; turn: string }> = [];
  const backgroundReports: string[] = [];
  const liveProcess = new ClaudeLiveProcess<Turn>({
    signature: 'opus|max',
    start: (openPrompt) => cli.start(openPrompt),
    callbacks: {
      onMessage: (message, turn) => {
        routed.push({ type: message.type, turn: turn.name });
      },
      onTurnSettled: (turn, settlement) => {
        settled.push({ turn: turn.name, settlement });
      },
      onBackgroundReport: (_result, turn) => {
        backgroundReports.push(turn.name);
      },
      onProcessError: () => {},
    },
    idleCeilingMs: 60_000,
    busyCeilingMs: 3_600_000,
    ...overrides,
  }, { name: 'first' });

  return { liveProcess, settled, routed, backgroundReports };
}

const userMessage = (text: string): AnyRecord => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
});

const lastUuid = (cli: ReturnType<typeof createFakeCli>): string => String(cli.stdin.at(-1)?.uuid);

test('a follow-up turn goes to the live process instead of a second one', async () => {
  const cli = createFakeCli();
  const { liveProcess, settled } = spawn(cli);

  const firstTurn = liveProcess.runTurn(userMessage('launch the agents'), { name: 'first' });
  await settleMicrotasks();
  const firstUuid = lastUuid(cli);

  // The turn launches a background agent, then ends while the agent works on.
  cli.emit(
    { type: 'system', subtype: 'task_started', task_id: 'agent-1', tool_use_id: 'toolu_agent', task_type: 'local_agent' },
    { type: 'result', subtype: 'success', user_message_uuid: firstUuid },
    { type: 'command_lifecycle', command_uuid: firstUuid, state: 'completed' },
  );
  assert.deepEqual(await firstTurn, { outcome: 'completed' });

  // The process is still there for the next message: nothing closed its stdin.
  assert.equal(cli.stdinClosed, false);
  assert.equal(liveProcess.accepts('opus|max'), true);

  const secondTurn = liveProcess.runTurn(userMessage('stop the farm'), { name: 'second' });
  await settleMicrotasks();
  assert.equal(cli.stdin.length, 2, 'the second message reached the same CLI');
  const secondUuid = lastUuid(cli);

  cli.emit(
    { type: 'result', subtype: 'success', user_message_uuid: secondUuid },
    { type: 'command_lifecycle', command_uuid: secondUuid, state: 'completed' },
  );
  assert.deepEqual(await secondTurn, { outcome: 'completed' });
  assert.deepEqual(settled.map((entry) => entry.turn), ['first', 'second']);
});

test("a background report's result does not end the user's turn", async () => {
  // A resumed process works through pending task notifications before the
  // user's message; ending the user's turn on that first result is what let a
  // second process start while the first was still busy.
  const cli = createFakeCli();
  const { liveProcess, settled, backgroundReports } = spawn(cli);

  const turn = liveProcess.runTurn(userMessage('here are the farm assets'), { name: 'first' });
  await settleMicrotasks();
  const uuid = lastUuid(cli);

  cli.emit({ type: 'result', subtype: 'success', origin: { kind: 'task-notification' } });
  await settleMicrotasks();
  assert.deepEqual(settled, [], 'the user turn is still running');
  assert.deepEqual(backgroundReports, ['first']);

  cli.emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' });
  assert.deepEqual(await turn, { outcome: 'completed' });
});

test('a message merged into a running turn settles on its own lifecycle event', async () => {
  const cli = createFakeCli();
  const { liveProcess, settled } = spawn(cli);

  const running = liveProcess.runTurn(userMessage('run the tests'), { name: 'first' });
  await settleMicrotasks();
  const runningUuid = lastUuid(cli);

  const merged = liveProcess.runTurn(userMessage('actually, forget the farm'), { name: 'second' });
  await settleMicrotasks();
  const mergedUuid = lastUuid(cli);

  // The CLI folds the second message into the turn already running: one
  // result, attributed to the message that started the turn.
  cli.emit(
    { type: 'command_lifecycle', command_uuid: mergedUuid, state: 'completed' },
    { type: 'result', subtype: 'success', user_message_uuid: runningUuid },
    { type: 'command_lifecycle', command_uuid: runningUuid, state: 'completed' },
  );

  assert.deepEqual(await merged, { outcome: 'completed' });
  assert.deepEqual(await running, { outcome: 'completed' });
  assert.deepEqual(settled.map((entry) => entry.turn).sort(), ['first', 'second']);
});

test('a result naming a later message also settles the ones queued before it', async () => {
  // CLIs without lifecycle events still read stdin in order.
  const cli = createFakeCli();
  const { liveProcess } = spawn(cli);

  const earlier = liveProcess.runTurn(userMessage('one'), { name: 'first' });
  await settleMicrotasks();
  const later = liveProcess.runTurn(userMessage('two'), { name: 'second' });
  await settleMicrotasks();

  cli.emit({ type: 'result', subtype: 'success', user_message_uuid: lastUuid(cli) });
  assert.deepEqual(await earlier, { outcome: 'completed' });
  assert.deepEqual(await later, { outcome: 'completed' });
});

test('stream messages are routed to the turn that last wrote to the process', async () => {
  const cli = createFakeCli();
  const { liveProcess, routed } = spawn(cli);

  void liveProcess.runTurn(userMessage('one'), { name: 'first' });
  await settleMicrotasks();
  cli.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
  await settleMicrotasks();

  void liveProcess.runTurn(userMessage('two'), { name: 'second' });
  await settleMicrotasks();
  cli.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'still working' }] } });
  await settleMicrotasks();

  assert.deepEqual(routed.map((entry) => entry.turn), ['first', 'second']);
});

test('the process is released once the CLI is idle with nothing outstanding', async () => {
  const cli = createFakeCli();
  const { liveProcess } = spawn(cli);

  const turn = liveProcess.runTurn(userMessage('hello'), { name: 'first' });
  await settleMicrotasks();
  const uuid = lastUuid(cli);

  cli.emit(
    { type: 'system', subtype: 'session_state_changed', state: 'running' },
    { type: 'result', subtype: 'success', user_message_uuid: uuid },
    { type: 'command_lifecycle', command_uuid: uuid, state: 'completed' },
  );
  await turn;
  await settleMicrotasks();
  assert.equal(cli.stdinClosed, false, 'the CLI has not reported idle yet');

  cli.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await settleMicrotasks();
  assert.equal(cli.stdinClosed, true);
  assert.equal(liveProcess.accepts('opus|max'), false);
  await assert.rejects(liveProcess.runTurn(userMessage('late'), { name: 'late' }));
});

test('without session states, a turn with nothing outstanding releases the process at its result', async () => {
  const cli = createFakeCli();
  const { liveProcess } = spawn(cli);

  const turn = liveProcess.runTurn(userMessage('hello'), { name: 'first' });
  await settleMicrotasks();

  cli.emit({ type: 'result', subtype: 'success', user_message_uuid: lastUuid(cli) });
  await turn;
  await settleMicrotasks();
  assert.equal(cli.stdinClosed, true);
});

test('a background agent keeps the process while the CLI still reports it running', async () => {
  const cli = createFakeCli();
  const { liveProcess } = spawn(cli);

  const turn = liveProcess.runTurn(userMessage('launch an agent'), { name: 'first' });
  await settleMicrotasks();
  const uuid = lastUuid(cli);

  cli.emit(
    { type: 'system', subtype: 'session_state_changed', state: 'running' },
    { type: 'system', subtype: 'task_started', task_id: 'agent-1', tool_use_id: 'toolu_agent', is_backgrounded: true, task_type: 'local_agent' },
    { type: 'result', subtype: 'success', user_message_uuid: uuid },
    { type: 'command_lifecycle', command_uuid: uuid, state: 'completed' },
  );
  await turn;
  await settleMicrotasks();

  assert.equal(cli.stdinClosed, false);
  assert.equal(liveProcess.accepts('opus|max'), true);
});

test('the last background task finishing waits for the turn that relays it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cli = createFakeCli();
  const { liveProcess } = spawn(cli);

  const turn = liveProcess.runTurn(userMessage('run the tests in the background'), { name: 'first' });
  await settleMicrotasks();
  const uuid = lastUuid(cli);

  cli.emit(
    { type: 'system', subtype: 'task_started', task_id: 'shell-1', tool_use_id: 'toolu_shell', is_backgrounded: true, task_type: 'local_bash' },
    { type: 'result', subtype: 'success', user_message_uuid: uuid },
    { type: 'command_lifecycle', command_uuid: uuid, state: 'completed' },
    { type: 'system', subtype: 'session_state_changed', state: 'idle' },
  );
  await turn;
  await settleMicrotasks();
  assert.equal(cli.stdinClosed, false, 'the shell is still running');

  // The shell exits and the CLI immediately starts the turn that reports it.
  cli.emit({ type: 'system', subtype: 'task_notification', task_id: 'shell-1', status: 'completed' });
  await settleMicrotasks();
  assert.equal(cli.stdinClosed, false, 'released before the relaying turn could run');

  cli.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  await settleMicrotasks();
  t.mock.timers.tick(60_000);
  await settleMicrotasks();
  assert.equal(cli.stdinClosed, false, 'the relaying turn is running');

  cli.emit(
    { type: 'result', subtype: 'success', origin: { kind: 'task-notification' } },
    { type: 'system', subtype: 'session_state_changed', state: 'idle' },
  );
  await settleMicrotasks();
  assert.equal(cli.stdinClosed, true);
});

test('stopping the last background task releases the process at once', async () => {
  const cli = createFakeCli();
  const { liveProcess } = spawn(cli);

  const turn = liveProcess.runTurn(userMessage('run the workflow'), { name: 'first' });
  await settleMicrotasks();
  const uuid = lastUuid(cli);
  cli.emit(
    { type: 'system', subtype: 'task_started', task_id: 'wf-1', tool_use_id: 'toolu_wf', task_type: 'local_workflow' },
    { type: 'result', subtype: 'success', user_message_uuid: uuid },
    { type: 'command_lifecycle', command_uuid: uuid, state: 'completed' },
  );
  await turn;
  await settleMicrotasks();
  assert.equal(cli.stdinClosed, false);

  // The CLI answers a stop with a `stopped` notification and no turn to relay it.
  cli.emit({ type: 'system', subtype: 'task_notification', task_id: 'wf-1', status: 'stopped' });
  await settleMicrotasks();
  assert.equal(cli.stdinClosed, true);
});

test('interrupting stops the turn but keeps the process and its background work', async () => {
  const cli = createFakeCli();
  const { liveProcess } = spawn(cli);

  const turn = liveProcess.runTurn(userMessage('long job'), { name: 'first' });
  await settleMicrotasks();
  const uuid = lastUuid(cli);
  cli.emit({ type: 'system', subtype: 'task_started', task_id: 'agent-1', tool_use_id: 'toolu_agent', is_backgrounded: true });

  assert.equal(await liveProcess.interrupt(), true);
  cli.emit(
    { type: 'result', subtype: 'error_during_execution', user_message_uuid: uuid },
    { type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' },
  );

  assert.deepEqual(await turn, { outcome: 'aborted' });
  assert.deepEqual(cli.calls, ['interrupt']);
  assert.equal(liveProcess.accepts('opus|max'), true);
});

test('an interrupt the CLI never acknowledges ends the process', async (t) => {
  // The process's own timeouts are unref'd so they never hold a server open;
  // here nothing else would keep the test alive until they fire.
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));

  const cli = createFakeCli({ acknowledgeInterrupt: false });
  const { liveProcess } = spawn(cli, { interruptTimeoutMs: 20 });

  const turn = liveProcess.runTurn(userMessage('long job'), { name: 'first' });
  await settleMicrotasks();

  assert.equal(await liveProcess.interrupt(), true);
  assert.deepEqual(await turn, { outcome: 'aborted' });
  assert.ok(cli.calls.includes('close'));
  assert.equal(liveProcess.accepts('opus|max'), false);
});

test('stopping interrupts while stdin is still open, then ends the process', async () => {
  // The original bug: stdin was closed first, so the interrupt could never
  // reach the CLI and the old process finished its turn next to the new one.
  const cli = createFakeCli();
  const { liveProcess, settled } = spawn(cli);

  const turn = liveProcess.runTurn(userMessage('long job'), { name: 'first' });
  await settleMicrotasks();

  await liveProcess.stop();
  await settleMicrotasks();

  assert.equal(cli.calls[0], 'interrupt');
  assert.ok(!cli.calls.includes('interrupt-after-stdin-closed'));
  assert.ok(cli.calls.includes('close'));
  assert.deepEqual(await turn, { outcome: 'superseded' });
  assert.deepEqual(settled, [{ turn: 'first', settlement: { outcome: 'superseded' } }]);
});

test('turns still waiting when the CLI dies are settled', async () => {
  const cli = createFakeCli();
  const { liveProcess } = spawn(cli);

  const turn = liveProcess.runTurn(userMessage('hello'), { name: 'first' });
  await settleMicrotasks();

  const crash = new Error('Claude Code process exited with code 1');
  cli.exit(crash);

  assert.deepEqual(await turn, { outcome: 'failed', error: crash });
  await liveProcess.ended;
  assert.equal(liveProcess.accepts('opus|max'), false);
});

test('a process spawned with other options does not take the turn', async () => {
  const cli = createFakeCli();
  const { liveProcess } = spawn(cli);

  assert.equal(liveProcess.accepts('opus|max'), true);
  assert.equal(liveProcess.accepts('sonnet|max'), false);
});

