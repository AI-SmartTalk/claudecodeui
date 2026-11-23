import { kanbanDb, projectsDb } from '@/modules/database/index.js';
import type {
  KanbanAgentStatus,
  KanbanCardRow,
  KanbanCardSessionRow,
  KanbanColumnKey,
  KanbanCommentAuthor,
  KanbanCommentRow,
} from '@/modules/database/index.js';
import type { KanbanAgentRunner } from '@/modules/kanban/services/kanban-agent.service.js';
import { AppError } from '@/shared/utils.js';

/** Board columns in display order; the only values `column` may take. */
export const KANBAN_COLUMNS: KanbanColumnKey[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];

/** Providers a card may be assigned to (mirrors LLMProvider). */
export const KANBAN_PROVIDERS = ['claude', 'codex', 'cursor', 'opencode'];

type KanbanCardSessionDto = {
  sessionId: string;
  title: string | null;
  provider: string | null;
  exists: boolean;
  linkedAt: string;
};

type KanbanCommentDto = {
  id: string;
  author: KanbanCommentAuthor;
  body: string;
  attachments: unknown[];
  sessionId: string | null;
  delivered: boolean;
  createdAt: string;
};

type KanbanCardDto = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  column: KanbanColumnKey;
  position: number;
  provider: string;
  /** null = the app's default model for `provider`. */
  model: string | null;
  attachments: unknown[];
  agentStatus: KanbanAgentStatus;
  agentError: string | null;
  sessions: KanbanCardSessionDto[];
  /** The conversation a comment continues: the newest linked one that still exists. */
  activeSessionId: string | null;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
};

/** SQLite's CURRENT_TIMESTAMP is UTC without a zone; clients need ISO 8601. */
function toIsoTimestamp(value: string | null): string {
  if (!value) {
    return new Date(0).toISOString();
  }
  return value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
}

function readJsonArray(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toSessionDto(row: KanbanCardSessionRow): KanbanCardSessionDto {
  return {
    sessionId: row.session_id,
    title: row.session_name,
    provider: row.session_provider,
    exists: Boolean(row.session_exists),
    linkedAt: toIsoTimestamp(row.created_at),
  };
}

function toCommentDto(row: KanbanCommentRow): KanbanCommentDto {
  return {
    id: row.id,
    author: row.author,
    body: row.body,
    attachments: readJsonArray(row.attachments),
    sessionId: row.session_id,
    delivered: Boolean(row.delivered_at),
    createdAt: toIsoTimestamp(row.created_at),
  };
}

function toCardDto(row: KanbanCardRow, sessions: KanbanCardSessionRow[], commentCount: number): KanbanCardDto {
  const sessionDtos = sessions.map(toSessionDto);
  const active = [...sessionDtos].reverse().find((session) => session.exists) ?? null;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    column: row.column_key,
    position: row.position,
    provider: row.provider,
    model: row.model,
    attachments: readJsonArray(row.attachments),
    agentStatus: row.agent_status,
    agentError: row.agent_error,
    sessions: sessionDtos,
    activeSessionId: active?.sessionId ?? null,
    commentCount,
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

function requireProject(projectId: string): void {
  if (!projectsDb.getProjectById(projectId)) {
    throw new AppError('Projet introuvable.', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }
}

function requireCard(cardId: string): KanbanCardRow {
  const card = kanbanDb.getCard(cardId);
  if (!card) {
    throw new AppError('Carte introuvable.', { code: 'KANBAN_CARD_NOT_FOUND', statusCode: 404 });
  }
  return card;
}

function buildCardDto(card: KanbanCardRow): KanbanCardDto {
  const comments = kanbanDb.listComments(card.id);
  return toCardDto(card, kanbanDb.listCardSessions(card.id), comments.length);
}

/** Validated input for creating a card (parsed by the routes). */
export type KanbanCardCreateInput = {
  title: string;
  description: string;
  column: KanbanColumnKey;
  provider: string;
  model: string | null;
  attachments: unknown[];
};

/** Validated partial update of a card (parsed by the routes). */
export type KanbanCardUpdateInput = Partial<KanbanCardCreateInput & { position: number }>;

let agentRunner: KanbanAgentRunner | null = null;

function requireRunner(): KanbanAgentRunner {
  if (!agentRunner) {
    throw new AppError('Le lancement d\'agents n\'est pas encore prêt.', { code: 'KANBAN_AGENT_UNAVAILABLE', statusCode: 503 });
  }
  return agentRunner;
}

/**
 * Board operations behind the Kanban routes. Card persistence is synchronous
 * SQLite; anything that launches or stops an agent goes through the runner,
 * which the server installs at boot with `setKanbanAgentRunner`.
 */
export const kanbanService = {
  listBoard(projectId: string): { columns: KanbanColumnKey[]; cards: KanbanCardDto[] } {
    requireProject(projectId);
    const sessionsByCard = new Map<string, KanbanCardSessionRow[]>();
    for (const row of kanbanDb.listProjectCardSessions(projectId)) {
      const list = sessionsByCard.get(row.card_id) ?? [];
      list.push(row);
      sessionsByCard.set(row.card_id, list);
    }
    const commentCounts = new Map(kanbanDb.countProjectComments(projectId).map((row) => [row.card_id, row.count]));
    const cards = kanbanDb.listCards(projectId).map((card) => toCardDto(
      card,
      sessionsByCard.get(card.id) ?? [],
      commentCounts.get(card.id) ?? 0,
    ));
    return { columns: KANBAN_COLUMNS, cards };
  },

  getCard(cardId: string): KanbanCardDto & { comments: KanbanCommentDto[] } {
    const card = requireCard(cardId);
    const comments = kanbanDb.listComments(cardId).map(toCommentDto);
    return {
      ...toCardDto(card, kanbanDb.listCardSessions(cardId), comments.length),
      comments,
    };
  },

  createCard(projectId: string, input: KanbanCardCreateInput): KanbanCardDto {
    requireProject(projectId);
    const card = kanbanDb.createCard({
      projectId,
      title: input.title,
      description: input.description,
      columnKey: input.column,
      provider: input.provider,
      model: input.model,
      attachments: input.attachments,
    });
    return buildCardDto(card);
  },

  updateCard(cardId: string, input: KanbanCardUpdateInput): KanbanCardDto {
    const card = requireCard(cardId);
    if (input.provider && input.provider !== card.provider && card.agent_status === 'running') {
      throw new AppError('Impossible de changer de fournisseur pendant que l\'agent travaille.', {
        code: 'KANBAN_CARD_BUSY',
        statusCode: 409,
      });
    }
    // A move without an explicit position lands at the bottom of the target column.
    const movesColumn = input.column !== undefined && input.column !== card.column_key;
    const position = input.position ?? (movesColumn ? kanbanDb.nextPosition(card.project_id, input.column as KanbanColumnKey) : undefined);
    const updated = kanbanDb.updateCard(cardId, {
      title: input.title,
      description: input.description,
      columnKey: input.column,
      position,
      provider: input.provider,
      // `undefined` leaves the model alone; `null` resets it to the default.
      model: input.model,
      attachments: input.attachments,
    }) as KanbanCardRow;
    return buildCardDto(updated);
  },

  async deleteCard(cardId: string): Promise<void> {
    const card = requireCard(cardId);
    if (card.agent_status === 'running') {
      await requireRunner().stopRun(cardId);
    }
    kanbanDb.deleteCard(cardId);
  },

  /**
   * Adds a user comment. With `relaunch`, the agent picks it up now when the
   * card is idle, or as soon as its current run ends when it is working.
   */
  async addComment(
    cardId: string,
    input: { body: string; attachments: unknown[]; relaunch: boolean; userId: number | null },
  ): Promise<KanbanCardDto & { comments: KanbanCommentDto[] }> {
    const card = requireCard(cardId);
    kanbanDb.addComment({
      cardId,
      author: 'user',
      body: input.body,
      attachments: input.attachments,
      // A comment that should not reach the agent is marked delivered up front.
      delivered: !input.relaunch,
    });
    if (input.relaunch && card.agent_status !== 'running' && card.agent_status !== 'queued') {
      await requireRunner().startRun(cardId, { userId: input.userId });
    }
    return kanbanService.getCard(cardId);
  },

  async startRun(cardId: string, input: { userId: number | null; newSession: boolean }): Promise<KanbanCardDto> {
    requireCard(cardId);
    await requireRunner().startRun(cardId, input);
    return buildCardDto(requireCard(cardId));
  },

  async stopRun(cardId: string): Promise<KanbanCardDto> {
    requireCard(cardId);
    await requireRunner().stopRun(cardId);
    return buildCardDto(requireCard(cardId));
  },

  async queueCards(projectId: string, input: { cardIds?: string[]; column?: KanbanColumnKey }): Promise<{ queued: number }> {
    requireProject(projectId);
    const queued = await requireRunner().queueCards(projectId, { cardIds: input.cardIds, columnKey: input.column });
    return { queued };
  },

  /** The card a conversation was opened from, so the chat can link back to it. */
  findCardBySession(sessionId: string): KanbanCardDto | null {
    const card = kanbanDb.findCardBySession(sessionId);
    return card ? buildCardDto(card) : null;
  },
};

/** Installs the agent runner; called once by the Kanban module's initializer at boot. */
export function setKanbanAgentRunner(runner: KanbanAgentRunner | null): void {
  agentRunner = runner;
}
