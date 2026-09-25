import crypto from 'node:crypto';

import type { AnyRecord } from '@/shared/types.js';

/**
 * One Claude CLI process per conversation, fed turn after turn through stdin.
 *
 * Every `--resume` spawn is one more writer on the conversation's transcript.
 * While an earlier process for the same conversation is still alive — held open
 * for background agents, or still finishing a turn the app already reported as
 * done — both append to the same file from the same parent. The conversation
 * forks, the next resume follows whichever branch was written last, and the
 * user sees Claude forget the message they just sent. The newcomer also reports
 * the older process's agents as "stopped", so Claude relaunches work that is
 * in fact still running.
 *
 * So a conversation keeps a single process while it has work in flight, and
 * each later turn is written to that process instead of spawning another.
 */

/** SDK stream record as the CLI emits it; every field is read defensively. */
type ClaudeStreamMessage = AnyRecord;

/**
 * The part of the SDK `Query` a live process drives. Structural so the tests
 * can script a CLI without spawning one.
 */
export type ClaudeQueryHandle = AsyncIterable<ClaudeStreamMessage> & {
  interrupt(): Promise<void>;
  close(): void;
};

/** How a user turn ended, as seen by the run that asked for it. */
export type ClaudeTurnSettlement =
  | { outcome: 'completed' }
  /** Stopped through `interrupt()`; the abort path reports it to the client. */
  | { outcome: 'aborted' }
  /** Dropped because a newer process took the conversation over. */
  | { outcome: 'superseded' }
  | { outcome: 'failed'; error: unknown };

/**
 * What a live process reports back to the runtime. `TTurn` is whatever the
 * runtime attaches to a turn (its writer, its notification label) — the
 * process only routes it, it never looks inside.
 */
export type ClaudeLiveProcessCallbacks<TTurn> = {
  /** Every stream message, routed to the turn that most recently wrote to stdin. */
  onMessage(message: ClaudeStreamMessage, turn: TTurn): void;
  /** Called exactly once per turn, when it settles. */
  onTurnSettled(turn: TTurn, settlement: ClaudeTurnSettlement): void | Promise<void>;
  /** A turn nobody typed finished: background work reported back. */
  onBackgroundReport(result: ClaudeStreamMessage, turn: TTurn): void;
  /** The process failed while no turn was waiting on it. */
  onProcessError(error: unknown, turn: TTurn): void | Promise<void>;
};

export type ClaudeLiveProcessOptions<TTurn> = {
  /**
   * Options the process was spawned with, serialized. A turn asking for other
   * options (a different model, effort, or permission mode) needs a new process.
   */
  signature: string;
  /**
   * Spawns the CLI. `openPrompt` returns the stdin stream; call it again when a
   * first spawn attempt has to be retried, since a stream serves one consumer.
   */
  start(openPrompt: () => AsyncIterable<ClaudeStreamMessage>): ClaudeQueryHandle;
  callbacks: ClaudeLiveProcessCallbacks<TTurn>;
  /**
   * Silence tolerated while the only thing left is deferred work that is not a
   * task (a scheduled wake-up) before stdin is closed anyway.
   */
  idleCeilingMs: number;
  /**
   * Silence tolerated while background tasks are still running. A background
   * shell reports nothing until it exits, so this is deliberately long; it only
   * bounds a task that never ends.
   */
  busyCeilingMs: number;
  /** How long an interrupt may take before the process is stopped outright. */
  interruptTimeoutMs?: number;
};

type PendingTurn<TTurn> = {
  /** Sent as the message `uuid`; the CLI echoes it in `command_lifecycle` and `result`. */
  uuid: string;
  turn: TTurn;
  aborted: boolean;
  resolve(settlement: ClaudeTurnSettlement): void;
};

type CliSessionState = 'idle' | 'running' | 'requires_action';

const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 10_000;
// A background task reports its end just before the CLI starts the turn that
// relays it, so the last task finishing is not yet a reason to let go.
const TASK_SETTLE_GRACE_MS = 10_000;

// Tool calls that leave work to happen after the turn without registering a
// background task the CLI would report on. Backgrounded shells, agents and
// monitors do register one, and are tracked through the task events instead;
// they stay listed here as a fallback for CLIs that emit no task events.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate']);

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);

/**
 * Detects tool calls that keep working after the turn's `result` arrives.
 * @param message - SDK stream message
 * @returns True when the message launches work that outlives the turn
 */
function startsDeferredWork(message: ClaudeStreamMessage): boolean {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block: AnyRecord) => {
    if (block?.type !== 'tool_use') {
      return false;
    }
    if (block.name === 'Bash') {
      return block.input?.run_in_background === true;
    }
    return DEFERRED_WORK_TOOLS.has(block.name);
  });
}

/** Origin kind of a result (`human`, `task-notification`, `peer`…), or null when absent. */
function readOriginKind(result: ClaudeStreamMessage): string | null {
  const kind = result.origin?.kind;
  return typeof kind === 'string' ? kind : null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * stdin for one CLI process. It stays open between turns — the SDK closes the
 * CLI's stdin as soon as its prompt stream ends, and the CLI reads that EOF as
 * "wind down", which is exactly what a held process must not do.
 */
function createPromptChannel() {
  const queued: ClaudeStreamMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  const resume = () => {
    const pending = wake;
    wake = null;
    pending?.();
  };

  return {
    push(message: ClaudeStreamMessage): void {
      queued.push(message);
      resume();
    },
    close(): void {
      closed = true;
      resume();
    },
    async *open(): AsyncGenerator<ClaudeStreamMessage> {
      while (true) {
        while (queued.length > 0) {
          yield queued.shift() as ClaudeStreamMessage;
        }
        if (closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/**
 * A running Claude CLI that serves every turn of one conversation until it has
 * nothing left to do.
 *
 * Used by the Claude runtime (`claude-runtime.provider.js`), which keeps one
 * per conversation and hands it each new turn instead of spawning a concurrent
 * `--resume`.
 *
 * Turn boundaries come from the CLI itself: `command_lifecycle` reports each
 * stdin message by the `uuid` it was sent with, and a `result` names the
 * message that started its turn. A `result` is not enough on its own — a
 * resumed process first works through pending task notifications, and a
 * message written mid-turn is merged into the turn already running — so
 * treating any `result` as "the user's turn is over" ends turns early.
 */
export class ClaudeLiveProcess<TTurn> {
  /** Settles once the CLI's stream has ended and every turn has been settled. */
  readonly ended: Promise<void>;

  private readonly options: ClaudeLiveProcessOptions<TTurn>;
  private readonly channel = createPromptChannel();
  private readonly query: ClaudeQueryHandle;
  private readonly pendingTurns: PendingTurn<TTurn>[] = [];
  private readonly backgroundTaskIds = new Set<string>();
  private currentTurn: TTurn;
  /** Last state the CLI announced; null when it does not emit session states. */
  private cliState: CliSessionState | null = null;
  private deferredWorkThisTurn = false;
  private holdForDeferredWork = false;
  private inputClosed = false;
  private stopping = false;
  private finished = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceCeilingMs = 0;

  constructor(options: ClaudeLiveProcessOptions<TTurn>, firstTurn: TTurn) {
    this.options = options;
    this.currentTurn = firstTurn;
    this.query = options.start(() => this.channel.open());
    this.ended = this.pump();
  }

  /** The turn stream messages are routed to: the one that last wrote to stdin. */
  get turn(): TTurn {
    return this.currentTurn;
  }

  /** True while the process can take another turn spawned with `signature`. */
  accepts(signature: string): boolean {
    return !this.inputClosed && !this.stopping && !this.finished && signature === this.options.signature;
  }

  /**
   * Writes one user message to the CLI and resolves when that turn settles.
   * Messages written while a turn is running are merged into it by the CLI,
   * the same way a message typed mid-turn in the terminal is.
   */
  runTurn(message: ClaudeStreamMessage, turn: TTurn): Promise<ClaudeTurnSettlement> {
    if (!this.accepts(this.options.signature)) {
      return Promise.reject(new Error('This Claude process no longer accepts new turns.'));
    }

    const uuid = crypto.randomUUID();
    return new Promise((resolve) => {
      this.pendingTurns.push({ uuid, turn, aborted: false, resolve });
      this.currentTurn = turn;
      this.clearSilenceTimer();
      this.channel.push({ ...message, uuid });
    });
  }

  /**
   * Stops the turn in flight. The process itself stays up, so background work
   * keeps running and the next message reuses it.
   * @returns False when the process had already ended
   */
  async interrupt(): Promise<boolean> {
    if (this.finished) {
      return false;
    }

    for (const pending of this.pendingTurns) {
      pending.aborted = true;
    }

    try {
      await withTimeout(this.query.interrupt(), this.interruptTimeoutMs);
    } catch (error) {
      // An interrupt the CLI never acknowledges would leave the turn running
      // behind a UI that shows it stopped. Ending the process is the only
      // stop that cannot be ignored.
      console.error('[Claude] Interrupt was not acknowledged; stopping the process:', error instanceof Error ? error.message : error);
      await this.stop();
    }
    return true;
  }

  /**
   * Ends the process for good, background work included, and waits for its
   * stream to close. Used before spawning a replacement, so two processes never
   * write to the same transcript.
   */
  async stop(): Promise<void> {
    if (!this.stopping && !this.finished) {
      this.stopping = true;
      this.clearSilenceTimer();
      if (!this.inputClosed) {
        // Interrupt while stdin is still open: once it closes, the control
        // request has no way to reach the CLI and the turn runs to its end.
        await withTimeout(this.query.interrupt(), this.interruptTimeoutMs).catch(() => undefined);
      }
      this.inputClosed = true;
      this.channel.close();
      this.query.close();
    }

    await withTimeout(this.ended, STOP_TIMEOUT_MS).catch(() => undefined);
  }

  private get interruptTimeoutMs(): number {
    return this.options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
  }

  private async pump(): Promise<void> {
    let failure: unknown = null;
    try {
      for await (const message of this.query) {
        this.track(message);
        // A process being replaced winds down silently: its client-facing
        // events belong to the process that takes over.
        if (!this.stopping) {
          this.options.callbacks.onMessage(message, this.currentTurn);
        }
        this.react(message);
      }
    } catch (error) {
      failure = error;
    }

    await this.finish(failure);
  }

  /** Bookkeeping that must be current before a message is forwarded. */
  private track(message: ClaudeStreamMessage): void {
    if (this.silenceTimer) {
      // The backstop measures silence, not total time.
      this.armSilenceTimer(this.silenceCeilingMs);
    }

    if (message.type === 'assistant' && startsDeferredWork(message)) {
      this.deferredWorkThisTurn = true;
    }

    if (message.type !== 'system') {
      return;
    }

    const taskId = typeof message.task_id === 'string' ? message.task_id : null;
    switch (message.subtype) {
      case 'background_tasks_changed':
        // The authoritative list: replaces whatever was inferred before.
        if (Array.isArray(message.tasks)) {
          this.backgroundTaskIds.clear();
          for (const task of message.tasks) {
            if (typeof task?.task_id === 'string') {
              this.backgroundTaskIds.add(task.task_id);
            }
          }
        }
        break;
      case 'task_started':
        if (taskId && message.is_backgrounded === true) {
          this.backgroundTaskIds.add(taskId);
        }
        break;
      case 'task_updated':
        if (taskId && TERMINAL_TASK_STATUSES.has(message.patch?.status)) {
          this.backgroundTaskIds.delete(taskId);
        } else if (taskId && message.patch?.is_backgrounded === true) {
          this.backgroundTaskIds.add(taskId);
        }
        break;
      case 'task_notification':
        if (taskId) {
          this.backgroundTaskIds.delete(taskId);
        }
        break;
      case 'session_state_changed':
        if (message.state === 'idle' || message.state === 'running' || message.state === 'requires_action') {
          this.cliState = message.state;
        }
        break;
      default:
        break;
    }
  }

  /** Settles turns and decides whether the process is still needed. */
  private react(message: ClaudeStreamMessage): void {
    if (message.type === 'command_lifecycle') {
      const pending = this.pendingTurns.find((candidate) => candidate.uuid === message.command_uuid);
      if (pending && (message.state === 'completed' || message.state === 'cancelled')) {
        this.settle(pending, { outcome: 'completed' });
        this.reconsiderHold();
      }
      return;
    }

    if (message.type === 'result') {
      // Deferred work started by the turn that just ended keeps the process
      // until the next turn — the one that work triggers — has run.
      this.holdForDeferredWork = this.deferredWorkThisTurn;
      this.deferredWorkThisTurn = false;
      this.settleTurnsAnsweredBy(message);
      this.reconsiderHold();
      return;
    }

    if (message.type === 'system' && message.subtype === 'session_state_changed') {
      this.reconsiderHold();
      return;
    }

    if (
      message.type === 'system'
      && ['background_tasks_changed', 'task_notification', 'task_updated'].includes(message.subtype)
    ) {
      this.reconsiderHold(TASK_SETTLE_GRACE_MS);
    }
  }

  private settleTurnsAnsweredBy(result: ClaudeStreamMessage): void {
    const answeredUuid = typeof result.user_message_uuid === 'string' ? result.user_message_uuid : null;
    const answeredIndex = answeredUuid
      ? this.pendingTurns.findIndex((candidate) => candidate.uuid === answeredUuid)
      : -1;

    if (answeredIndex !== -1) {
      // The CLI reads stdin in order, so a message written before the one this
      // result answers was merged into that turn or finished before it.
      for (const pending of this.pendingTurns.slice(0, answeredIndex + 1)) {
        this.settle(pending, { outcome: 'completed' });
      }
      return;
    }

    const origin = readOriginKind(result);
    // A CLI that predates per-message ids still marks who started the turn: a
    // human-origin result answers the oldest message waiting on one.
    const legacyHumanResult = !answeredUuid && (origin === null || origin === 'human');
    if (legacyHumanResult && this.pendingTurns.length > 0) {
      this.settle(this.pendingTurns[0], { outcome: 'completed' });
      return;
    }

    if (!this.stopping && (origin === 'task-notification' || (legacyHumanResult && this.pendingTurns.length === 0))) {
      this.options.callbacks.onBackgroundReport(result, this.currentTurn);
    }
  }

  private settle(pending: PendingTurn<TTurn>, settlement: ClaudeTurnSettlement): void {
    const index = this.pendingTurns.indexOf(pending);
    if (index === -1) {
      return;
    }
    this.pendingTurns.splice(index, 1);

    const finalSettlement: ClaudeTurnSettlement = pending.aborted
      ? { outcome: 'aborted' }
      : this.stopping
        ? { outcome: 'superseded' }
        : settlement;

    // Reported synchronously so the terminal event keeps its place in the
    // stream; the turn's promise waits for any asynchronous reporting.
    let reporting: void | Promise<void> = undefined;
    try {
      reporting = this.options.callbacks.onTurnSettled(pending.turn, finalSettlement);
    } catch (error) {
      console.error('[Claude] Failed to report a settled turn:', error);
    }
    void Promise.resolve(reporting)
      .catch((error: unknown) => {
        console.error('[Claude] Failed to report a settled turn:', error);
      })
      .finally(() => pending.resolve(finalSettlement));
  }

  /**
   * Closes stdin once nothing can happen anymore, so the CLI exits. A process
   * with a turn in flight, a running background task, or deferred work pending
   * is kept, with a silence backstop so an abandoned one cannot leak forever.
   * @param releaseGraceMs - Wait this long for fresh activity before releasing
   */
  private reconsiderHold(releaseGraceMs = 0): void {
    if (this.inputClosed || this.stopping || this.finished) {
      return;
    }

    if (this.pendingTurns.length > 0) {
      this.clearSilenceTimer();
      return;
    }

    // A background agent keeps the CLI "running" between turns; it only goes
    // idle once every agent has reported back.
    const cliBusy = this.cliState === 'running' || this.cliState === 'requires_action';
    if (this.backgroundTaskIds.size > 0 || cliBusy) {
      this.armSilenceTimer(this.options.busyCeilingMs);
      return;
    }

    if (this.holdForDeferredWork) {
      this.armSilenceTimer(this.options.idleCeilingMs);
      return;
    }

    if (releaseGraceMs > 0) {
      this.armSilenceTimer(releaseGraceMs);
      return;
    }

    this.releaseInput();
  }

  private releaseInput(): void {
    if (this.inputClosed) {
      return;
    }
    this.inputClosed = true;
    this.clearSilenceTimer();
    this.channel.close();
  }

  private armSilenceTimer(ceilingMs: number): void {
    this.clearSilenceTimer();
    this.silenceCeilingMs = ceilingMs;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      console.log(`[Claude] Nothing left to wait for after ${Math.round(ceilingMs / 1000)}s; releasing the held CLI process.`);
      this.releaseInput();
    }, ceilingMs);
    // Never let the hold keep the server process alive on its own.
    this.silenceTimer.unref?.();
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private async finish(failure: unknown): Promise<void> {
    this.finished = true;
    this.inputClosed = true;
    this.clearSilenceTimer();
    this.channel.close();

    const unsettled = this.pendingTurns.slice();
    for (const pending of unsettled) {
      this.settle(pending, failure === null ? { outcome: 'completed' } : { outcome: 'failed', error: failure });
    }

    if (failure !== null && unsettled.length === 0 && !this.stopping) {
      try {
        await this.options.callbacks.onProcessError(failure, this.currentTurn);
      } catch (error) {
        console.error('[Claude] Failed to report a process error:', error);
      }
    }
  }
}
