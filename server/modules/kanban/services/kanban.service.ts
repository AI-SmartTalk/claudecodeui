import { kanbanDb, projectsDb } from '@/modules/database/index.js';
import type {
  KanbanAgentStatus,
  KanbanCardRow,
  KanbanCardSessionRow,
  KanbanColumnKey,
  KanbanCommentAuthor,
  KanbanCommentRow,
  KanbanConnectorRow,
} from '@/modules/database/index.js';
import type { KanbanAgentRunner } from '@/modules/kanban/services/kanban-agent.service.js';
import type { KanbanSyncService } from '@/modules/kanban/services/kanban-sync.service.js';
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

/** The tracker ticket a card mirrors. */
type KanbanExternalDto = {
  source: string;
  key: string | null;
  url: string | null;
  status: string | null;
  priority: string | null;
  type: string | null;
  labels: string[];
  assignee: string | null;
};

/** What the agent is doing right now, for the card's live strip. */
type KanbanActivityDto = {
  running: boolean;
  sessionId: string | null;
  /** Most recent first, at most a handful. */
  steps: Array<{ kind: 'tool' | 'text' | 'status'; label: string; detail: string | null; at: string | null }>;
};

/** A project's connector as clients see it: never the secret, only whether one is stored. */
type KanbanConnectorDto = {
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  hasSecret: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastSyncCount: number | null;
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
  /** null for a card created on the board. */
  external: KanbanExternalDto | null;
  /** The agent's latest reply, so "to test" cards can show it without loading the thread. */
  latestAgentReply: string | null;
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

function readObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toExternalDto(row: KanbanCardRow): KanbanExternalDto | null {
  if (!row.source) {
    return null;
  }
  const meta = readObject(row.external_meta);
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  return {
    source: row.source,
    key: row.external_key,
    url: row.external_url,
    status: row.external_status,
    priority: text(meta.priority),
    type: text(meta.type),
    labels: Array.isArray(meta.labels) ? meta.labels.filter((label): label is string => typeof label === 'string') : [],
    assignee: text(meta.assignee),
  };
}

function toConnectorDto(row: KanbanConnectorRow): KanbanConnectorDto {
  return {
    type: row.type,
    enabled: Boolean(row.enabled),
    config: readObject(row.config),
    hasSecret: Boolean(row.secret),
    lastSyncAt: row.last_sync_at ? toIsoTimestamp(row.last_sync_at) : null,
    lastSyncError: row.last_sync_error,
    lastSyncCount: row.last_sync_count,
  };
}

/** Longest agent reply excerpt carried on board cards. */
const REPLY_EXCERPT_LENGTH = 600;

function toCardDto(
  row: KanbanCardRow,
  sessions: KanbanCardSessionRow[],
  commentCount: number,
  latestAgentReply: string | null = null,
): KanbanCardDto {
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
    external: toExternalDto(row),
    latestAgentReply: latestAgentReply && latestAgentReply.length > REPLY_EXCERPT_LENGTH
      ? `${latestAgentReply.slice(0, REPLY_EXCERPT_LENGTH)}…`
      : latestAgentReply,
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

function latestAgentReplyOf(comments: KanbanCommentRow[]): string | null {
  return [...comments].reverse().find((comment) => comment.author === 'agent')?.body ?? null;
}

function buildCardDto(card: KanbanCardRow): KanbanCardDto {
  const comments = kanbanDb.listComments(card.id);
  return toCardDto(card, kanbanDb.listCardSessions(card.id), comments.length, latestAgentReplyOf(comments));
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
let syncService: KanbanSyncService | null = null;
let activityReader: ((sessionId: string) => KanbanActivityDto['steps']) | null = null;
let busyReader: ((sessionId: string) => boolean) | null = null;

function requireSync(): KanbanSyncService {
  if (!syncService) {
    throw new AppError('La synchronisation n\'est pas encore prête.', { code: 'KANBAN_SYNC_UNAVAILABLE', statusCode: 503 });
  }
  return syncService;
}

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
      // Only the "to test" column shows the reply on the board; skip the read elsewhere.
      card.column_key === 'review' ? latestAgentReplyOf(kanbanDb.listComments(card.id)) : null,
    ));
    return { columns: KANBAN_COLUMNS, cards };
  },

  getCard(cardId: string): KanbanCardDto & { comments: KanbanCommentDto[] } {
    const card = requireCard(cardId);
    const rows = kanbanDb.listComments(cardId);
    const comments = rows.map(toCommentDto);
    return {
      ...toCardDto(card, kanbanDb.listCardSessions(cardId), comments.length, latestAgentReplyOf(rows)),
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
    if (movesColumn && syncService) {
      void syncService.onCardMoved(cardId, input.column as KanbanColumnKey);
    }
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

  /** What the agent is doing on a card right now, read from its live run. */
  getActivity(cardId: string): KanbanActivityDto {
    requireCard(cardId);
    const latest = [...kanbanDb.listCardSessions(cardId)].reverse().find((session) => session.session_exists);
    if (!latest) {
      return { running: false, sessionId: null, steps: [] };
    }
    return {
      running: busyReader?.(latest.session_id) ?? false,
      sessionId: latest.session_id,
      steps: activityReader?.(latest.session_id) ?? [],
    };
  },

  getConnector(projectId: string): KanbanConnectorDto | null {
    requireProject(projectId);
    const row = kanbanDb.getConnector(projectId);
    return row ? toConnectorDto(row) : null;
  },

  saveConnector(projectId: string, input: { type: string; config: Record<string, unknown>; secret?: string; enabled: boolean }): KanbanConnectorDto {
    requireProject(projectId);
    if (!input.secret && !kanbanDb.getConnector(projectId)?.secret) {
      throw new AppError('Le token API est requis.', { code: 'KANBAN_CONNECTOR_INVALID', statusCode: 400 });
    }
    return toConnectorDto(kanbanDb.saveConnector({ projectId, ...input }));
  },

  /** Unlinks the tracker. Imported cards stay on the board as plain cards. */
  deleteConnector(projectId: string): void {
    requireProject(projectId);
    kanbanDb.deleteConnector(projectId);
  },

  async testConnector(projectId: string, input: { type: string; config: Record<string, unknown>; secret?: string }) {
    requireProject(projectId);
    return requireSync().testConnection(projectId, input);
  },

  async syncConnector(projectId: string) {
    requireProject(projectId);
    return requireSync().syncProject(projectId);
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

/**
 * Installs the tracker sync and the live-run readers; called once by the
 * Kanban module's initializer at boot (tests install fakes).
 */
export function setKanbanRuntime(runtime: {
  sync: KanbanSyncService | null;
  readActivity?: ((sessionId: string) => KanbanActivityDto['steps']) | null;
  isSessionBusy?: ((sessionId: string) => boolean) | null;
}): void {
  syncService = runtime.sync;
  activityReader = runtime.readActivity ?? null;
  busyReader = runtime.isSessionBusy ?? null;
}
