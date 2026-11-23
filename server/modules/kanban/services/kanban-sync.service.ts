import { kanbanDb } from '@/modules/database/index.js';
import type { KanbanCardRow, KanbanColumnKey, KanbanConnectorRow } from '@/modules/database/index.js';
import type {
  KanbanConnectorContext,
  KanbanExternalStatus,
  KanbanTrackerConnector,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** How often enabled connectors are pulled in the background. */
const SYNC_INTERVAL_MS = 5 * 60_000;

/** Prefix of the comment mirrored to the tracker when the agent finishes, so it reads as the agent's. */
const AGENT_COMMENT_PREFIX = '🤖 Agent CloudCLI :\n\n';

/** Longest agent reply mirrored to the tracker; the rest stays on the card. */
const MAX_MIRRORED_COMMENT_LENGTH = 4000;

/** Where a ticket lands by default, from its status category. */
const DEFAULT_COLUMN_BY_CATEGORY: Record<string, KanbanColumnKey> = {
  new: 'backlog',
  indeterminate: 'in_progress',
  done: 'done',
};

const COLUMNS: KanbanColumnKey[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];

/** Settings shared by every connector, read leniently from the stored config. */
type SyncOptions = {
  /** Tracker status name → board column, overriding the category default. */
  statusMapping: Record<string, KanbanColumnKey>;
  /** Mirror card moves to the tracker. */
  pushStatus: boolean;
  /** Mirror the agent's final reply as a tracker comment. */
  postAgentComments: boolean;
};

function readSyncOptions(config: Record<string, unknown>): SyncOptions {
  const mapping = config.statusMapping && typeof config.statusMapping === 'object'
    ? Object.fromEntries(
      Object.entries(config.statusMapping as Record<string, unknown>)
        .filter((entry): entry is [string, KanbanColumnKey] => COLUMNS.includes(entry[1] as KanbanColumnKey)),
    )
    : {};
  return {
    statusMapping: mapping,
    pushStatus: config.pushStatus !== false,
    postAgentComments: config.postAgentComments !== false,
  };
}

/** The board column a tracker status maps to: explicit mapping first, then its category. */
export function columnForStatus(status: KanbanExternalStatus, statusMapping: Record<string, KanbanColumnKey>): KanbanColumnKey {
  return statusMapping[status.name] ?? DEFAULT_COLUMN_BY_CATEGORY[status.category] ?? 'backlog';
}

function readConfig(row: KanbanConnectorRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(row.config);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Keeps project boards and their external trackers in step.
 *
 * Pull: tickets selected by the connector's query become cards (or refresh
 * theirs). Push: a card moved on the board moves its ticket, and the agent's
 * final reply is posted on the ticket. Pushes are best-effort and never block
 * the board: a failure is noted on the card as a system comment.
 *
 * Consumed by the Kanban service (routes, card moves) and the agent runner
 * (agent replies), and started with the server for the periodic pull.
 */
export function createKanbanSyncService(connectors: KanbanTrackerConnector[]) {
  const byType = new Map(connectors.map((connector) => [connector.type, connector]));
  /** Projects being pulled right now, so the timer and a manual sync never overlap. */
  const syncing = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function requireConnector(type: string): KanbanTrackerConnector {
    const connector = byType.get(type);
    if (!connector) {
      throw new AppError(`Source « ${type} » non prise en charge.`, { code: 'KANBAN_CONNECTOR_UNSUPPORTED', statusCode: 400 });
    }
    return connector;
  }

  function contextFor(row: KanbanConnectorRow): KanbanConnectorContext | null {
    if (!row.secret) {
      return null;
    }
    return { config: readConfig(row), secret: row.secret };
  }

  async function syncProject(projectId: string): Promise<{ created: number; updated: number; total: number }> {
    const row = kanbanDb.getConnector(projectId);
    if (!row) {
      throw new AppError('Aucune source externe n\'est liée à ce projet.', { code: 'KANBAN_CONNECTOR_MISSING', statusCode: 404 });
    }
    const context = contextFor(row);
    if (!context) {
      throw new AppError('Le token de la source externe est manquant.', { code: 'KANBAN_CONNECTOR_INVALID', statusCode: 400 });
    }
    if (syncing.has(projectId)) {
      throw new AppError('Une synchronisation est déjà en cours.', { code: 'KANBAN_SYNC_BUSY', statusCode: 409 });
    }
    syncing.add(projectId);
    try {
      const connector = requireConnector(row.type);
      const options = readSyncOptions(context.config);
      const tickets = await connector.fetchTickets(context);
      let created = 0;
      let updated = 0;
      for (const ticket of tickets) {
        const { outcome } = kanbanDb.upsertExternalCard({
          projectId,
          source: row.type,
          externalId: ticket.id,
          externalKey: ticket.key,
          externalUrl: ticket.url,
          externalStatus: ticket.status.name,
          externalUpdatedAt: ticket.updatedAt,
          externalMeta: ticket.meta,
          title: ticket.title,
          description: ticket.description,
          columnKey: columnForStatus(ticket.status, options.statusMapping),
        });
        if (outcome === 'created') created += 1;
        if (outcome === 'updated') updated += 1;
      }
      kanbanDb.recordConnectorSync(projectId, { error: null, count: tickets.length });
      return { created, updated, total: tickets.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      kanbanDb.recordConnectorSync(projectId, { error: message, count: null });
      throw error;
    } finally {
      syncing.delete(projectId);
    }
  }

  /** Checks settings before they are saved; falls back to the stored token when none is typed. */
  async function testConnection(projectId: string, input: { type: string; config: Record<string, unknown>; secret?: string }) {
    const secret = input.secret ?? kanbanDb.getConnector(projectId)?.secret ?? null;
    if (!secret) {
      throw new AppError('Le token API est requis.', { code: 'KANBAN_CONNECTOR_INVALID', statusCode: 400 });
    }
    const result = await requireConnector(input.type).testConnection({ config: input.config, secret });
    const options = readSyncOptions(input.config);
    // Shows where each status would land, so the mapping screen starts from the defaults.
    return {
      account: result.account,
      statuses: result.statuses.map((status) => ({ ...status, column: columnForStatus(status, options.statusMapping) })),
    };
  }

  /** The connector to push to for a card, or null when the card or project is not linked. */
  function pushTarget(card: KanbanCardRow) {
    if (!card.source || !card.external_key) {
      return null;
    }
    const row = kanbanDb.getConnector(card.project_id);
    if (!row || !row.enabled || row.type !== card.source) {
      return null;
    }
    const context = contextFor(row);
    const connector = byType.get(row.type);
    if (!context || !connector) {
      return null;
    }
    return { context, connector, options: readSyncOptions(context.config) };
  }

  /** Mirrors a card move to its ticket. Never throws: a failure becomes a note on the card. */
  async function onCardMoved(cardId: string, column: KanbanColumnKey): Promise<void> {
    const card = kanbanDb.getCard(cardId);
    if (!card) return;
    const target = pushTarget(card);
    if (!target || !target.options.pushStatus || !card.external_key) return;
    try {
      const status = await target.connector.moveTicket(target.context, card.external_key, column);
      if (status) {
        kanbanDb.updateCard(cardId, { externalStatus: status });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      kanbanDb.addComment({
        cardId,
        author: 'system',
        body: `Impossible de déplacer ${card.external_key} dans ${card.source} : ${message}`,
        delivered: true,
      });
    }
  }

  /** Posts the agent's final reply on the ticket. Never throws. */
  async function onAgentReply(cardId: string, body: string): Promise<void> {
    const card = kanbanDb.getCard(cardId);
    if (!card) return;
    const target = pushTarget(card);
    if (!target || !target.options.postAgentComments || !card.external_key) return;
    const text = body.length > MAX_MIRRORED_COMMENT_LENGTH
      ? `${body.slice(0, MAX_MIRRORED_COMMENT_LENGTH)}\n\n…`
      : body;
    try {
      await target.connector.addComment(target.context, card.external_key, `${AGENT_COMMENT_PREFIX}${text}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      kanbanDb.addComment({
        cardId,
        author: 'system',
        body: `Impossible de publier le commentaire sur ${card.external_key} : ${message}`,
        delivered: true,
      });
    }
  }

  async function syncAll(): Promise<void> {
    for (const row of kanbanDb.listEnabledConnectors()) {
      try {
        await syncProject(row.project_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[Kanban] Background sync failed', { projectId: row.project_id, error: message });
      }
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => void syncAll(), SYNC_INTERVAL_MS);
    // Never keep the process alive just for the sync.
    timer.unref?.();
    void syncAll();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { syncProject, testConnection, onCardMoved, onAgentReply, start, stop };
}

/** The sync service's public surface, as the Kanban service and runner hold it. */
export type KanbanSyncService = ReturnType<typeof createKanbanSyncService>;
