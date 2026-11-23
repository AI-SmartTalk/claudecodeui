import { kanbanDb } from '@/modules/database/index.js';
import type { KanbanCardRow, KanbanColumnKey, KanbanCommentRow } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * Everything the agent runner needs from the rest of the app, injected so the
 * card lifecycle can be tested without a provider, a socket or a transcript.
 */
export type KanbanAgentDependencies = {
  /** Runs one turn on a session with no client attached; resolves when it settles. */
  runTurn(input: {
    sessionId: string;
    userId: number | null;
    content: string;
    options: Record<string, unknown>;
  }): Promise<{ started: boolean; error: string | null }>;
  /** Aborts the session's current run, if any. */
  abortSession(sessionId: string): Promise<boolean>;
  isSessionBusy(sessionId: string): boolean;
  sessionExists(sessionId: string): boolean;
  /** Allocates an app session in the project, the same way the chat's "new session" does. */
  createSession(provider: string, projectPath: string, title: string): string;
  /** The model a new conversation of this provider starts on (Settings > default model). */
  getDefaultModel(provider: string): Promise<string | null>;
  /** The agent's final words in the session, used as its comment on the card. */
  readLastAssistantMessage(sessionId: string): Promise<string | null>;
  getProjectPath(projectId: string): string | null;
  /** Mirrors a column change made by the runner to the card's external ticket, if any. */
  onCardMoved?(cardId: string, column: KanbanColumnKey): void;
  /** Mirrors the agent's final reply to the card's external ticket, if any. */
  onAgentReply?(cardId: string, body: string): void;
};

/** What a run was asked to do. */
type StartRunOptions = {
  userId: number | null;
  /** Start a fresh conversation even when the card already has one. */
  newSession?: boolean;
};

/** Longest agent reply copied onto the card; the full one is in the conversation. */
const MAX_AGENT_COMMENT_LENGTH = 8000;

function readAttachments(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function describeComments(comments: KanbanCommentRow[]): string {
  return comments
    .map((comment) => `- ${comment.body.trim() || '(pièce jointe)'}`)
    .join('\n');
}

/**
 * The first message of a card's conversation. It carries the whole card, and
 * the closing instructions are what make the reply usable as the card's
 * "what to test" comment.
 */
function buildBriefPrompt(card: KanbanCardRow, comments: KanbanCommentRow[]): string {
  const sections = [
    `Tu travailles sur la carte Kanban « ${card.title} » de ce projet.`,
  ];
  if (card.description.trim()) {
    sections.push(`## Description\n\n${card.description.trim()}`);
  }
  if (comments.length > 0) {
    sections.push(`## Commentaires\n\n${describeComments(comments)}`);
  }
  sections.push(
    [
      '## Ce que j\'attends',
      '',
      'Réalise la tâche de bout en bout, de façon autonome : je ne suis pas là pour répondre aux questions.',
      'Si un point est ambigu, fais le choix le plus raisonnable et signale-le.',
      'Termine ta réponse par un court résumé : ce que tu as fait, puis les étapes précises pour que je teste.',
      'Si tu as pris des captures d\'écran, mets-les dans ta réponse en lien markdown.',
    ].join('\n'),
  );
  return sections.join('\n\n');
}

/** A follow-up turn on a card's existing conversation, carrying the new comments. */
function buildFollowUpPrompt(card: KanbanCardRow, comments: KanbanCommentRow[]): string {
  if (comments.length === 0) {
    return `Reprends le travail sur la carte « ${card.title} » là où tu t'étais arrêté. Termine par un court résumé et les étapes pour tester.`;
  }
  return [
    `Nouveaux commentaires sur la carte « ${card.title} » :`,
    '',
    describeComments(comments),
    '',
    'Prends-les en compte, puis termine par un court résumé et les étapes pour tester.',
  ].join('\n');
}

/**
 * Creates the runner that launches agents on kanban cards.
 *
 * Consumed by the Kanban service (routes) and started by the server at boot.
 * The card is the source of truth for what was asked: `agent_status` moves
 * idle/queued → running → idle (column: review) or failed (column: todo), and
 * every transition back from running is conditional on the card still being
 * running, so a stop or a newer run is never overwritten by a late settle.
 */
export function createKanbanAgentRunner(dependencies: KanbanAgentDependencies) {
  /** Notifies the sync hook when a transition actually moved the card. */
  function notifyMove(cardId: string, before: KanbanColumnKey, after: KanbanColumnKey | undefined): void {
    if (after && after !== before) {
      dependencies.onCardMoved?.(cardId, after);
    }
  }

  /** Projects whose queue is being advanced right now, so two settles cannot both start the next card. */
  const pumping = new Set<string>();

  async function resolveSession(card: KanbanCardRow, projectPath: string, newSession: boolean) {
    const linked = kanbanDb.listCardSessions(card.id);
    const latest = linked.at(-1);
    // A session's provider is fixed for life: a card switched to another
    // provider needs a new conversation.
    const reusable = !newSession
      && latest
      && (latest.session_provider ?? card.provider) === card.provider
      && dependencies.sessionExists(latest.session_id);
    if (reusable) {
      return { sessionId: latest.session_id, isNew: false };
    }
    const sessionId = dependencies.createSession(card.provider, projectPath, card.title);
    kanbanDb.linkSession(card.id, sessionId);
    return { sessionId, isNew: true };
  }

  async function settle(
    cardId: string,
    sessionId: string,
    claimed: KanbanCommentRow[],
    result: { started: boolean; error: string | null },
    userId: number | null,
  ): Promise<void> {
    const card = kanbanDb.getCard(cardId);
    if (!card) {
      return;
    }

    if (!result.started || result.error) {
      if (!result.started) {
        // Never reached the agent: the comments it was carrying are still owed.
        kanbanDb.releaseComments(claimed.map((comment) => comment.id));
      }
      const reason = result.error ?? 'L\'agent n\'a pas pu démarrer.';
      const failedColumn = card.column_key === 'in_progress' ? 'todo' as const : undefined;
      const transitioned = kanbanDb.transitionAgentStatus(cardId, 'running', {
        agentStatus: 'failed',
        agentError: reason,
        columnKey: failedColumn,
      });
      if (transitioned) {
        notifyMove(cardId, card.column_key, failedColumn);
        kanbanDb.addComment({ cardId, author: 'system', body: `Échec de l'agent : ${reason}`, sessionId, delivered: true });
      }
      await pump(card.project_id);
      return;
    }

    const doneColumn = card.column_key === 'in_progress' ? 'review' as const : undefined;
    const transitioned = kanbanDb.transitionAgentStatus(cardId, 'running', {
      agentStatus: 'idle',
      agentError: null,
      columnKey: doneColumn,
    });
    if (!transitioned) {
      // Stopped by the user, or superseded: whoever changed the state owns the card now.
      return;
    }
    notifyMove(cardId, card.column_key, doneColumn);

    let reply: string | null = null;
    try {
      reply = await dependencies.readLastAssistantMessage(sessionId);
    } catch {
      // The card still moves on; the conversation link is there to read it.
    }
    if (reply?.trim()) {
      const body = reply.length > MAX_AGENT_COMMENT_LENGTH
        ? `${reply.slice(0, MAX_AGENT_COMMENT_LENGTH)}\n\n… (suite dans la conversation)`
        : reply;
      kanbanDb.addComment({ cardId, author: 'agent', body, sessionId, delivered: true });
      dependencies.onAgentReply?.(cardId, reply);
    }

    // A comment written while the agent worked is answered right away, in the same conversation.
    if (kanbanDb.hasUndeliveredUserComments(cardId)) {
      try {
        await startRun(cardId, { userId });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Kanban] Could not relaunch for pending comments', { cardId, error: message });
      }
    }
    await pump(card.project_id);
  }

  /**
   * Launches the agent on a card and returns as soon as the run is admitted;
   * the run itself goes on in the background and settles the card when done.
   */
  async function startRun(cardId: string, options: StartRunOptions): Promise<KanbanCardRow> {
    const card = kanbanDb.getCard(cardId);
    if (!card) {
      throw new AppError('Carte introuvable.', { code: 'KANBAN_CARD_NOT_FOUND', statusCode: 404 });
    }
    if (card.agent_status === 'running') {
      throw new AppError('L\'agent travaille déjà sur cette carte.', { code: 'KANBAN_CARD_BUSY', statusCode: 409 });
    }
    const projectPath = dependencies.getProjectPath(card.project_id);
    if (!projectPath) {
      throw new AppError('Projet introuvable.', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    }

    const { sessionId, isNew } = await resolveSession(card, projectPath, Boolean(options.newSession));
    if (dependencies.isSessionBusy(sessionId)) {
      throw new AppError(
        'La conversation de cette carte est déjà en cours d\'exécution. Réessaie quand elle aura fini.',
        { code: 'KANBAN_SESSION_BUSY', statusCode: 409 },
      );
    }

    const claimed = kanbanDb.claimUndeliveredUserComments(cardId, sessionId);
    const prompt = isNew ? buildBriefPrompt(card, claimed) : buildFollowUpPrompt(card, claimed);
    const attachments = [
      ...(isNew ? readAttachments(card.attachments) : []),
      ...claimed.flatMap((comment) => readAttachments(comment.attachments)),
    ];

    let model: string | null = card.model;
    if (!model) {
      try {
        model = await dependencies.getDefaultModel(card.provider);
      } catch {
        model = null;
      }
    }

    const runningColumn = card.column_key === 'done' ? undefined : 'in_progress' as const;
    const updated = kanbanDb.updateCard(cardId, {
      agentStatus: 'running',
      agentError: null,
      columnKey: runningColumn,
    }) as KanbanCardRow;
    notifyMove(cardId, card.column_key, runningColumn);

    const turn = dependencies.runTurn({
      sessionId,
      userId: options.userId,
      content: prompt,
      options: {
        ...(model ? { model } : {}),
        // Nobody is watching to approve tools: that is the whole point of the board.
        permissionMode: 'bypassPermissions',
        skipPermissions: true,
        attachments,
        sessionSummary: card.title,
      },
    });

    void turn
      .catch((error: unknown) => ({
        started: true,
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((result) => settle(cardId, sessionId, claimed, result, options.userId))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Kanban] Settling a card run failed', { cardId, error: message });
      });

    return updated;
  }

  /** Stops the agent on a card; the card goes back to "to do" and keeps its conversation. */
  async function stopRun(cardId: string): Promise<KanbanCardRow> {
    const card = kanbanDb.getCard(cardId);
    if (!card) {
      throw new AppError('Carte introuvable.', { code: 'KANBAN_CARD_NOT_FOUND', statusCode: 404 });
    }
    if (card.agent_status === 'queued') {
      return kanbanDb.updateCard(cardId, { agentStatus: 'idle' }) as KanbanCardRow;
    }
    if (card.agent_status !== 'running') {
      return card;
    }
    // Card first: the run's settle then sees it is no longer running and leaves it alone.
    const stoppedColumn = card.column_key === 'in_progress' ? 'todo' as const : undefined;
    if (kanbanDb.transitionAgentStatus(cardId, 'running', { agentStatus: 'idle', columnKey: stoppedColumn })) {
      notifyMove(cardId, card.column_key, stoppedColumn);
    }
    kanbanDb.addComment({ cardId, author: 'system', body: 'Agent arrêté.', delivered: true });
    const latest = kanbanDb.listCardSessions(cardId).at(-1);
    if (latest) {
      await dependencies.abortSession(latest.session_id).catch(() => false);
    }
    await pump(card.project_id);
    return kanbanDb.getCard(cardId) as KanbanCardRow;
  }

  /**
   * Starts the next queued card of a project when none of its cards is
   * running. Queued cards run one at a time per project because they share
   * one working copy: two agents editing the same files would trample each
   * other.
   */
  async function pump(projectId: string): Promise<void> {
    if (pumping.has(projectId)) {
      return;
    }
    pumping.add(projectId);
    try {
      for (;;) {
        const cards = kanbanDb.listCards(projectId);
        if (cards.some((card) => card.agent_status === 'running')) {
          return;
        }
        const next = cards
          .filter((card) => card.agent_status === 'queued')
          .sort((left, right) => left.position - right.position)[0];
        if (!next) {
          return;
        }
        try {
          await startRun(next.id, { userId: null });
          return;
        } catch (error) {
          // Mark it failed and try the one after it, rather than stalling the whole queue.
          const message = error instanceof Error ? error.message : String(error);
          kanbanDb.updateCard(next.id, { agentStatus: 'failed', agentError: message });
          kanbanDb.addComment({ cardId: next.id, author: 'system', body: `Échec de l'agent : ${message}`, delivered: true });
        }
      }
    } finally {
      pumping.delete(projectId);
    }
  }

  /** Queues cards (all of a column when no ids are given) and starts the first one. */
  async function queueCards(projectId: string, input: { cardIds?: string[]; columnKey?: string }): Promise<number> {
    const cards = kanbanDb.listCards(projectId).filter((card) => (
      input.cardIds ? input.cardIds.includes(card.id) : card.column_key === (input.columnKey ?? 'todo')
    ));
    let queued = 0;
    for (const card of cards) {
      if (card.agent_status === 'idle' || card.agent_status === 'failed') {
        kanbanDb.updateCard(card.id, { agentStatus: 'queued', agentError: null });
        queued += 1;
      }
    }
    await pump(projectId);
    return queued;
  }

  /**
   * Run at boot. A card left "running" belonged to a process that is gone, so
   * it is reported as interrupted; queued cards survive the restart and their
   * queues start again.
   */
  async function recover(): Promise<void> {
    for (const card of kanbanDb.listCardsByAgentStatus('running')) {
      kanbanDb.transitionAgentStatus(card.id, 'running', {
        agentStatus: 'failed',
        agentError: 'Interrompu par un redémarrage du serveur.',
        columnKey: card.column_key === 'in_progress' ? 'todo' : undefined,
      });
    }
    const projects = new Set(kanbanDb.listCardsByAgentStatus('queued').map((card) => card.project_id));
    for (const projectId of projects) {
      await pump(projectId);
    }
  }

  return { startRun, stopRun, queueCards, recover };
}

/** The runner's public surface, as the Kanban service holds it. */
export type KanbanAgentRunner = ReturnType<typeof createKanbanAgentRunner>;
