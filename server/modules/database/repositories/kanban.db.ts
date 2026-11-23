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
  created_at: string;
  updated_at: string;
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
  'id, project_id, title, description, column_key, position, provider, model, attachments, agent_status, agent_error, created_at, updated_at';

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
};
