import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

/** The fixed columns of a project board, in display order. */
export type KanbanColumnKey = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';

/** What the card knows of its agent; see the schema comment on `kanban_cards`. */
export type KanbanAgentStatus = 'idle' | 'queued' | 'running' | 'failed';

/** Who wrote a comment on a card. */
export type KanbanCommentAuthor = 'user' | 'agent' | 'system';

export type KanbanCardRow = {
  id: string;
  project_id: string;
  title: string;
  description: string;
  column_key: KanbanColumnKey;
  position: number;
  provider: string;
  model: string | null;
  attachments: string;
  agent_status: KanbanAgentStatus;
  agent_error: string | null;
  source: string | null;
  external_id: string | null;
  external_key: string | null;
  external_url: string | null;
  external_status: string | null;
  external_updated_at: string | null;
  external_meta: string | null;
  created_at: string;
  updated_at: string;
};

export type KanbanConnectorRow = {
  project_id: string;
  type: string;
  config: string;
  secret: string | null;
  enabled: number;
  last_sync_at: string | null;
  last_sync_error: string | null;
  last_sync_count: number | null;
  created_at: string;
  updated_at: string;
};

/** A ticket as a connector hands it to the board, already mapped to a column. */
export type KanbanExternalCardInput = {
  projectId: string;
  source: string;
  externalId: string;
  externalKey: string;
  externalUrl: string | null;
  externalStatus: string;
  externalUpdatedAt: string | null;
  externalMeta: Record<string, unknown>;
  title: string;
  description: string;
  columnKey: KanbanColumnKey;
};

export type KanbanCardSessionRow = {
  card_id: string;
  session_id: string;
  created_at: string;
  /** From the joined session row; null once the conversation was deleted. */
  session_name: string | null;
  session_provider: string | null;
  session_exists: number;
};

export type KanbanCommentRow = {
  id: string;
  card_id: string;
  author: KanbanCommentAuthor;
  body: string;
  attachments: string;
  session_id: string | null;
  delivered_at: string | null;
  created_at: string;
};

const CARD_COLUMNS =
  'id, project_id, title, description, column_key, position, provider, model, attachments, agent_status, agent_error, '
  + 'source, external_id, external_key, external_url, external_status, external_updated_at, external_meta, created_at, updated_at';

const CONNECTOR_COLUMNS =
  'project_id, type, config, secret, enabled, last_sync_at, last_sync_error, last_sync_count, created_at, updated_at';

const COMMENT_COLUMNS =
  'id, card_id, author, body, attachments, session_id, delivered_at, created_at';

/** Fields a caller may change on a card; omitted fields are left as they are. */
type KanbanCardPatch = Partial<{
  title: string;
  description: string;
  columnKey: KanbanColumnKey;
  position: number;
  provider: string;
  model: string | null;
  attachments: unknown[];
  agentStatus: KanbanAgentStatus;
  agentError: string | null;
  externalStatus: string | null;
}>;

const PATCH_COLUMN_BY_FIELD: Record<keyof KanbanCardPatch, string> = {
  title: 'title',
  description: 'description',
  columnKey: 'column_key',
  position: 'position',
  provider: 'provider',
  model: 'model',
  attachments: 'attachments',
  agentStatus: 'agent_status',
  agentError: 'agent_error',
  externalStatus: 'external_status',
};

// kanbanDb: used by the Kanban module to persist project boards, the
// conversations linked to each card and each card's comment thread.
export const kanbanDb = {
  listCards(projectId: string): KanbanCardRow[] {
    return getConnection()
      .prepare(
        `SELECT ${CARD_COLUMNS} FROM kanban_cards
         WHERE project_id = ?
         ORDER BY column_key, position ASC, created_at ASC`,
      )
      .all(projectId) as KanbanCardRow[];
  },

  getCard(cardId: string): KanbanCardRow | null {
    const row = getConnection()
      .prepare(`SELECT ${CARD_COLUMNS} FROM kanban_cards WHERE id = ?`)
      .get(cardId) as KanbanCardRow | undefined;
    return row ?? null;
  },

  /** Cards in one agent state, across every project (startup recovery, queue). */
  listCardsByAgentStatus(status: KanbanAgentStatus): KanbanCardRow[] {
    return getConnection()
      .prepare(
        `SELECT ${CARD_COLUMNS} FROM kanban_cards
         WHERE agent_status = ?
         ORDER BY updated_at ASC`,
      )
      .all(status) as KanbanCardRow[];
  },

  /** The position just past the last card of a column, so a new card lands at the bottom. */
  nextPosition(projectId: string, columnKey: KanbanColumnKey): number {
    const row = getConnection()
      .prepare('SELECT MAX(position) AS maxPosition FROM kanban_cards WHERE project_id = ? AND column_key = ?')
      .get(projectId, columnKey) as { maxPosition: number | null };
    return (row.maxPosition ?? 0) + 1;
  },

  createCard(input: {
    projectId: string;
    title: string;
    description: string;
    columnKey: KanbanColumnKey;
    provider: string;
    model: string | null;
    attachments: unknown[];
  }): KanbanCardRow {
    const db = getConnection();
    const id = randomUUID();
    const position = kanbanDb.nextPosition(input.projectId, input.columnKey);
    db.prepare(
      `INSERT INTO kanban_cards (id, project_id, title, description, column_key, position, provider, model, attachments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.projectId,
      input.title,
      input.description,
      input.columnKey,
      position,
      input.provider,
      input.model,
      JSON.stringify(input.attachments),
    );
    return kanbanDb.getCard(id) as KanbanCardRow;
  },

  updateCard(cardId: string, patch: KanbanCardPatch): KanbanCardRow | null {
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [field, value] of Object.entries(patch) as Array<[keyof KanbanCardPatch, unknown]>) {
      if (value === undefined) {
        continue;
      }
      assignments.push(`${PATCH_COLUMN_BY_FIELD[field]} = ?`);
      values.push(field === 'attachments' ? JSON.stringify(value) : value);
    }
    if (assignments.length > 0) {
      getConnection()
        .prepare(`UPDATE kanban_cards SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(...values, cardId);
    }
    return kanbanDb.getCard(cardId);
  },

  /**
   * Moves a card to `idle`/`failed` only if it is still in `expected`, so a run
   * that settles late cannot overwrite a state the user (or a newer run) set.
   */
  transitionAgentStatus(
    cardId: string,
    expected: KanbanAgentStatus,
    next: { agentStatus: KanbanAgentStatus; agentError?: string | null; columnKey?: KanbanColumnKey },
  ): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        `UPDATE kanban_cards
         SET agent_status = ?, agent_error = ?, column_key = COALESCE(?, column_key), updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND agent_status = ?`,
      )
      .run(next.agentStatus, next.agentError ?? null, next.columnKey ?? null, cardId, expected);
    return result.changes > 0;
  },

  deleteCard(cardId: string): boolean {
    const db = getConnection();
    // Explicit rather than relying on ON DELETE CASCADE: foreign key
    // enforcement is a per-connection pragma.
    const remove = db.transaction((id: string) => {
      db.prepare('DELETE FROM kanban_card_comments WHERE card_id = ?').run(id);
      db.prepare('DELETE FROM kanban_card_sessions WHERE card_id = ?').run(id);
      return db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(id).changes > 0;
    });
    return remove(cardId);
  },

  linkSession(cardId: string, sessionId: string): void {
    getConnection()
      .prepare('INSERT OR IGNORE INTO kanban_card_sessions (card_id, session_id) VALUES (?, ?)')
      .run(cardId, sessionId);
  },

  /** Linked conversations, oldest first, joined with whatever the sessions table still knows. */
  listCardSessions(cardId: string): KanbanCardSessionRow[] {
    return getConnection()
      .prepare(
        `SELECT ks.card_id, ks.session_id, ks.created_at,
                s.custom_name AS session_name,
                s.provider AS session_provider,
                CASE WHEN s.session_id IS NULL THEN 0 ELSE 1 END AS session_exists
         FROM kanban_card_sessions ks
         LEFT JOIN sessions s ON s.session_id = ks.session_id
         WHERE ks.card_id = ?
         ORDER BY ks.created_at ASC, ks.rowid ASC`,
      )
      .all(cardId) as KanbanCardSessionRow[];
  },

  /** Linked sessions for every card of a project in one query, for the board view. */
  listProjectCardSessions(projectId: string): KanbanCardSessionRow[] {
    return getConnection()
      .prepare(
        `SELECT ks.card_id, ks.session_id, ks.created_at,
                s.custom_name AS session_name,
                s.provider AS session_provider,
                CASE WHEN s.session_id IS NULL THEN 0 ELSE 1 END AS session_exists
         FROM kanban_card_sessions ks
         JOIN kanban_cards c ON c.id = ks.card_id
         LEFT JOIN sessions s ON s.session_id = ks.session_id
         WHERE c.project_id = ?
         ORDER BY ks.created_at ASC, ks.rowid ASC`,
      )
      .all(projectId) as KanbanCardSessionRow[];
  },

  /** The card a conversation belongs to, if any (to show the card from the chat). */
  findCardBySession(sessionId: string): KanbanCardRow | null {
    const row = getConnection()
      .prepare(
        `SELECT ${CARD_COLUMNS.split(', ').map((column) => `c.${column}`).join(', ')}
         FROM kanban_cards c
         JOIN kanban_card_sessions ks ON ks.card_id = c.id
         WHERE ks.session_id = ?
         LIMIT 1`,
      )
      .get(sessionId) as KanbanCardRow | undefined;
    return row ?? null;
  },

  addComment(input: {
    cardId: string;
    author: KanbanCommentAuthor;
    body: string;
    attachments?: unknown[];
    sessionId?: string | null;
    delivered?: boolean;
  }): KanbanCommentRow {
    const db = getConnection();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO kanban_card_comments (id, card_id, author, body, attachments, session_id, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ${input.delivered ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
    ).run(
      id,
      input.cardId,
      input.author,
      input.body,
      JSON.stringify(input.attachments ?? []),
      input.sessionId ?? null,
    );
    db.prepare('UPDATE kanban_cards SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(input.cardId);
    return db.prepare(`SELECT ${COMMENT_COLUMNS} FROM kanban_card_comments WHERE id = ?`).get(id) as KanbanCommentRow;
  },

  listComments(cardId: string): KanbanCommentRow[] {
    return getConnection()
      .prepare(
        `SELECT ${COMMENT_COLUMNS} FROM kanban_card_comments
         WHERE card_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(cardId) as KanbanCommentRow[];
  },

  /** Comment counts per card of a project, for the badges on the board. */
  countProjectComments(projectId: string): Array<{ card_id: string; count: number }> {
    return getConnection()
      .prepare(
        `SELECT cc.card_id, COUNT(*) AS count
         FROM kanban_card_comments cc
         JOIN kanban_cards c ON c.id = cc.card_id
         WHERE c.project_id = ?
         GROUP BY cc.card_id`,
      )
      .all(projectId) as Array<{ card_id: string; count: number }>;
  },

  /**
   * Claims the user comments no run has carried yet, marking them delivered in
   * the same transaction so two runs can never send the same comment twice.
   */
  claimUndeliveredUserComments(cardId: string, sessionId: string): KanbanCommentRow[] {
    const db = getConnection();
    const claim = db.transaction(() => {
      const rows = db
        .prepare(
          `SELECT ${COMMENT_COLUMNS} FROM kanban_card_comments
           WHERE card_id = ? AND author = 'user' AND delivered_at IS NULL
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(cardId) as KanbanCommentRow[];
      if (rows.length > 0) {
        db.prepare(
          `UPDATE kanban_card_comments SET delivered_at = CURRENT_TIMESTAMP, session_id = ?
           WHERE card_id = ? AND author = 'user' AND delivered_at IS NULL`,
        ).run(sessionId, cardId);
      }
      return rows;
    });
    return claim();
  },

  /** Puts claimed comments back when the run that claimed them never started. */
  releaseComments(commentIds: string[]): void {
    if (commentIds.length === 0) {
      return;
    }
    const placeholders = commentIds.map(() => '?').join(', ');
    getConnection()
      .prepare(`UPDATE kanban_card_comments SET delivered_at = NULL WHERE id IN (${placeholders})`)
      .run(...commentIds);
  },

  hasUndeliveredUserComments(cardId: string): boolean {
    const row = getConnection()
      .prepare(
        `SELECT 1 AS found FROM kanban_card_comments
         WHERE card_id = ? AND author = 'user' AND delivered_at IS NULL
         LIMIT 1`,
      )
      .get(cardId) as { found: number } | undefined;
    return Boolean(row);
  },

  findCardByExternal(projectId: string, source: string, externalId: string): KanbanCardRow | null {
    const row = getConnection()
      .prepare(`SELECT ${CARD_COLUMNS} FROM kanban_cards WHERE project_id = ? AND source = ? AND external_id = ?`)
      .get(projectId, source, externalId) as KanbanCardRow | undefined;
    return row ?? null;
  },

  /**
   * Creates or refreshes the card mirroring an external ticket.
   *
   * Content (title, description, meta) follows the tracker only when the
   * ticket changed there since the last pull, so local edits survive a sync of
   * an untouched ticket. The column follows the tracker only when the
   * tracker's status changed, and never while the agent is working on the card.
   */
  upsertExternalCard(input: KanbanExternalCardInput): { card: KanbanCardRow; outcome: 'created' | 'updated' | 'unchanged' } {
    const db = getConnection();
    const existing = kanbanDb.findCardByExternal(input.projectId, input.source, input.externalId);
    if (!existing) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO kanban_cards (id, project_id, title, description, column_key, position, source, external_id,
           external_key, external_url, external_status, external_updated_at, external_meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.projectId,
        input.title,
        input.description,
        input.columnKey,
        kanbanDb.nextPosition(input.projectId, input.columnKey),
        input.source,
        input.externalId,
        input.externalKey,
        input.externalUrl,
        input.externalStatus,
        input.externalUpdatedAt,
        JSON.stringify(input.externalMeta),
      );
      return { card: kanbanDb.getCard(id) as KanbanCardRow, outcome: 'created' };
    }

    const contentChanged = input.externalUpdatedAt !== existing.external_updated_at;
    const statusChanged = input.externalStatus !== existing.external_status;
    if (!contentChanged && !statusChanged) {
      return { card: existing, outcome: 'unchanged' };
    }
    const moveColumn = statusChanged && existing.agent_status !== 'running' && input.columnKey !== existing.column_key;
    db.prepare(
      `UPDATE kanban_cards SET
         title = CASE WHEN ? THEN ? ELSE title END,
         description = CASE WHEN ? THEN ? ELSE description END,
         external_meta = CASE WHEN ? THEN ? ELSE external_meta END,
         external_key = ?, external_url = ?, external_status = ?, external_updated_at = ?,
         column_key = CASE WHEN ? THEN ? ELSE column_key END,
         position = CASE WHEN ? THEN ? ELSE position END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(
      contentChanged ? 1 : 0, input.title,
      contentChanged ? 1 : 0, input.description,
      contentChanged ? 1 : 0, JSON.stringify(input.externalMeta),
      input.externalKey, input.externalUrl, input.externalStatus, input.externalUpdatedAt,
      moveColumn ? 1 : 0, input.columnKey,
      moveColumn ? 1 : 0, moveColumn ? kanbanDb.nextPosition(input.projectId, input.columnKey) : 0,
      existing.id,
    );
    return { card: kanbanDb.getCard(existing.id) as KanbanCardRow, outcome: 'updated' };
  },

  getConnector(projectId: string): KanbanConnectorRow | null {
    const row = getConnection()
      .prepare(`SELECT ${CONNECTOR_COLUMNS} FROM kanban_connectors WHERE project_id = ?`)
      .get(projectId) as KanbanConnectorRow | undefined;
    return row ?? null;
  },

  listEnabledConnectors(): KanbanConnectorRow[] {
    return getConnection()
      .prepare(`SELECT ${CONNECTOR_COLUMNS} FROM kanban_connectors WHERE enabled = 1`)
      .all() as KanbanConnectorRow[];
  },

  /** Saves a connector. A `secret` of undefined keeps the stored one (the client never sees it). */
  saveConnector(input: { projectId: string; type: string; config: unknown; secret?: string; enabled: boolean }): KanbanConnectorRow {
    const db = getConnection();
    db.prepare(
      `INSERT INTO kanban_connectors (project_id, type, config, secret, enabled)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         type = excluded.type,
         config = excluded.config,
         secret = COALESCE(?, kanban_connectors.secret),
         enabled = excluded.enabled,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(
      input.projectId,
      input.type,
      JSON.stringify(input.config ?? {}),
      input.secret ?? null,
      input.enabled ? 1 : 0,
      input.secret ?? null,
    );
    return kanbanDb.getConnector(input.projectId) as KanbanConnectorRow;
  },

  deleteConnector(projectId: string): boolean {
    return getConnection().prepare('DELETE FROM kanban_connectors WHERE project_id = ?').run(projectId).changes > 0;
  },

  recordConnectorSync(projectId: string, result: { error: string | null; count: number | null }): void {
    getConnection()
      .prepare(
        `UPDATE kanban_connectors
         SET last_sync_at = CURRENT_TIMESTAMP, last_sync_error = ?, last_sync_count = COALESCE(?, last_sync_count)
         WHERE project_id = ?`,
      )
      .run(result.error, result.count, projectId);
  },
};
