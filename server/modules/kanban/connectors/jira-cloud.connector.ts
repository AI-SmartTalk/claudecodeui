import type {
  KanbanBoardColumn,
  KanbanConnectorContext,
  KanbanExternalStatus,
  KanbanExternalTicket,
  KanbanTrackerConnector,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Upper bound on tickets pulled per sync, so a broad query cannot flood the board. */
const MAX_TICKETS_PER_SYNC = 300;
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 20_000;

const SEARCH_FIELDS = ['summary', 'description', 'status', 'issuetype', 'priority', 'labels', 'assignee', 'updated'];

/** Jira Cloud settings as stored in the connector's `config`. */
type JiraConfig = {
  baseUrl: string;
  email: string;
  projectKey: string | null;
  jql: string | null;
  importDone: boolean;
  /** Board column → exact Jira status name to move to, overriding the category guess. */
  columnToStatus: Partial<Record<KanbanBoardColumn, string>>;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type JiraStatusField = { name?: string; statusCategory?: { key?: string } };

type JiraIssue = {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: JiraStatusField;
    issuetype?: { name?: string };
    priority?: { name?: string } | null;
    labels?: string[];
    assignee?: { displayName?: string } | null;
    updated?: string;
  };
};

type JiraTransition = { id: string; name: string; to?: JiraStatusField };

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Validates and normalizes the stored config; throws a readable error when it is unusable. */
function readJiraConfig(raw: Record<string, unknown>): JiraConfig {
  const baseUrl = readString(raw.baseUrl)?.replace(/\/+$/, '') ?? null;
  if (!baseUrl || !/^https:\/\/[^/\s]+$/i.test(baseUrl)) {
    throw new AppError('Adresse Jira invalide : attendu https://votre-site.atlassian.net', {
      code: 'KANBAN_CONNECTOR_INVALID',
      statusCode: 400,
    });
  }
  const email = readString(raw.email);
  if (!email) {
    throw new AppError('L\'email du compte Jira est requis.', { code: 'KANBAN_CONNECTOR_INVALID', statusCode: 400 });
  }
  const projectKey = readString(raw.projectKey);
  const jql = readString(raw.jql);
  if (!projectKey && !jql) {
    throw new AppError('Indique une clé de projet Jira ou une requête JQL.', {
      code: 'KANBAN_CONNECTOR_INVALID',
      statusCode: 400,
    });
  }
  const columnToStatus = raw.columnToStatus && typeof raw.columnToStatus === 'object'
    ? Object.fromEntries(
      Object.entries(raw.columnToStatus as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== ''),
    ) as Partial<Record<KanbanBoardColumn, string>>
    : {};
  return { baseUrl, email, projectKey, jql, importDone: raw.importDone === true, columnToStatus };
}

/** The query a sync runs: the user's JQL, or the project's open tickets. */
export function buildJiraQuery(config: { projectKey: string | null; jql: string | null; importDone: boolean }): string {
  if (config.jql) {
    return config.jql;
  }
  const scope = `project = "${(config.projectKey ?? '').replace(/"/g, '')}"`;
  return config.importDone
    ? `${scope} ORDER BY updated DESC`
    : `${scope} AND statusCategory != Done ORDER BY updated DESC`;
}

function marksWrap(text: string, marks: unknown): string {
  if (!Array.isArray(marks)) {
    return text;
  }
  let wrapped = text;
  for (const mark of marks as Array<{ type?: string; attrs?: { href?: string } }>) {
    if (mark.type === 'strong') wrapped = `**${wrapped}**`;
    else if (mark.type === 'em') wrapped = `_${wrapped}_`;
    else if (mark.type === 'code') wrapped = `\`${wrapped}\``;
    else if (mark.type === 'link' && mark.attrs?.href) wrapped = `[${wrapped}](${mark.attrs.href})`;
  }
  return wrapped;
}

/**
 * Converts Atlassian Document Format (Jira v3 descriptions) to markdown-ish
 * text: enough structure for an agent and a human to read, without trying to
 * round-trip every node type.
 */
export function adfToMarkdown(node: unknown, depth = 0): string {
  if (typeof node === 'string') {
    return node;
  }
  if (!node || typeof node !== 'object') {
    return '';
  }
  const record = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown>; marks?: unknown };
  const children = (separator = '') => (record.content ?? []).map((child) => adfToMarkdown(child, depth + 1)).join(separator);

  switch (record.type) {
    case 'doc':
      return children('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    case 'paragraph':
      return children();
    case 'text':
      return marksWrap(record.text ?? '', record.marks);
    case 'hardBreak':
      return '\n';
    case 'heading':
      return `${'#'.repeat(Number(record.attrs?.level) || 2)} ${children()}`;
    case 'bulletList':
      return (record.content ?? []).map((item) => `- ${adfToMarkdown(item, depth + 1)}`).join('\n');
    case 'orderedList':
      return (record.content ?? []).map((item, index) => `${index + 1}. ${adfToMarkdown(item, depth + 1)}`).join('\n');
    case 'listItem':
      return children('\n').replace(/\n/g, '\n  ');
    case 'codeBlock':
      return `\`\`\`${typeof record.attrs?.language === 'string' ? record.attrs.language : ''}\n${children()}\n\`\`\``;
    case 'blockquote':
      return children('\n\n').split('\n').map((line) => `> ${line}`).join('\n');
    case 'rule':
      return '---';
    case 'mention':
      return String(record.attrs?.text ?? '@mention');
    case 'emoji':
      return String(record.attrs?.text ?? record.attrs?.shortName ?? '');
    case 'inlineCard':
    case 'blockCard':
      return String(record.attrs?.url ?? '');
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '[pièce jointe Jira]';
    case 'table':
      return children('\n');
    case 'tableRow':
      return `| ${(record.content ?? []).map((cell) => adfToMarkdown(cell, depth + 1).replace(/\n/g, ' ')).join(' | ')} |`;
    default:
      return children(record.type && /Cell|Header/.test(record.type) ? ' ' : '');
  }
}

function toStatus(field: JiraStatusField | undefined): KanbanExternalStatus {
  return { name: field?.name ?? 'Unknown', category: field?.statusCategory?.key ?? 'new' };
}

const IN_PROGRESS_NAME = /progress|cours|doing|dev/i;
const REVIEW_NAME = /review|revue|test|qa|recette|valid|verif/i;

/**
 * Picks the transition that best mirrors a board column: an exact status name
 * from the mapping first, then the column's status category, preferring a
 * "review/test"-like name for the review column and a non-review name for
 * in-progress.
 */
export function pickJiraTransition(
  transitions: JiraTransition[],
  column: KanbanBoardColumn,
  columnToStatus: Partial<Record<KanbanBoardColumn, string>>,
): JiraTransition | null {
  const wanted = columnToStatus[column]?.toLowerCase();
  if (wanted) {
    const exact = transitions.find((transition) => transition.to?.name?.toLowerCase() === wanted);
    if (exact) return exact;
  }
  const category = column === 'done' ? 'done' : column === 'in_progress' || column === 'review' ? 'indeterminate' : 'new';
  const candidates = transitions.filter((transition) => transition.to?.statusCategory?.key === category);
  if (candidates.length === 0) return null;
  if (column === 'review') {
    return candidates.find((transition) => REVIEW_NAME.test(transition.to?.name ?? '')) ?? null;
  }
  if (column === 'in_progress') {
    return candidates.find((transition) => IN_PROGRESS_NAME.test(transition.to?.name ?? ''))
      ?? candidates.find((transition) => !REVIEW_NAME.test(transition.to?.name ?? ''))
      ?? candidates[0];
  }
  return candidates[0];
}

/**
 * Jira Cloud through its REST API, authenticated with an Atlassian account
 * email and API token (Basic auth). Consumed by the Kanban sync service, which
 * only knows the generic connector contract.
 */
export function createJiraCloudConnector(fetchImpl: FetchLike = fetch): KanbanTrackerConnector {
  async function request<T>(context: KanbanConnectorContext, path: string, init: RequestInit = {}): Promise<T> {
    const config = readJiraConfig(context.config);
    const auth = Buffer.from(`${config.email}:${context.secret}`).toString('base64');
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Basic ${auth}`,
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError(`Jira injoignable : ${message}`, { code: 'KANBAN_CONNECTOR_UNREACHABLE', statusCode: 502 });
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError('Jira refuse ces identifiants (email ou token API).', {
        code: 'KANBAN_CONNECTOR_UNAUTHORIZED',
        statusCode: 400,
      });
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
        detail = [...(parsed.errorMessages ?? []), ...Object.values(parsed.errors ?? {})].join(' ') || detail;
      } catch {
        // Keep the raw excerpt.
      }
      throw new AppError(`Jira a répondu ${response.status} : ${detail}`, {
        code: 'KANBAN_CONNECTOR_ERROR',
        statusCode: 502,
      });
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    type: 'jira',

    async testConnection(context) {
      const config = readJiraConfig(context.config);
      const myself = await request<{ displayName?: string; emailAddress?: string }>(context, '/rest/api/3/myself');
      let statuses: KanbanExternalStatus[] = [];
      if (config.projectKey) {
        const byType = await request<Array<{ statuses?: JiraStatusField[] }>>(
          context,
          `/rest/api/3/project/${encodeURIComponent(config.projectKey)}/statuses`,
        );
        const seen = new Map<string, KanbanExternalStatus>();
        for (const issueType of byType) {
          for (const status of issueType.statuses ?? []) {
            const normalized = toStatus(status);
            seen.set(normalized.name, normalized);
          }
        }
        statuses = [...seen.values()];
      } else {
        // A bare JQL has no project to ask: the statuses of what it returns are enough.
        const tickets = await this.fetchTickets(context);
        statuses = [...new Map(tickets.map((ticket) => [ticket.status.name, ticket.status])).values()];
      }
      return { account: myself.displayName ?? myself.emailAddress ?? config.email, statuses };
    },

    async fetchTickets(context) {
      const config = readJiraConfig(context.config);
      const jql = buildJiraQuery(config);
      const tickets: KanbanExternalTicket[] = [];
      let nextPageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          jql,
          maxResults: String(PAGE_SIZE),
          fields: SEARCH_FIELDS.join(','),
        });
        if (nextPageToken) params.set('nextPageToken', nextPageToken);
        const page = await request<{ issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>(
          context,
          `/rest/api/3/search/jql?${params.toString()}`,
        );
        for (const issue of page.issues ?? []) {
          tickets.push({
            id: issue.id,
            key: issue.key,
            url: `${config.baseUrl}/browse/${issue.key}`,
            title: issue.fields.summary?.trim() || issue.key,
            description: adfToMarkdown(issue.fields.description),
            status: toStatus(issue.fields.status),
            updatedAt: issue.fields.updated ?? null,
            meta: {
              priority: issue.fields.priority?.name ?? null,
              type: issue.fields.issuetype?.name ?? null,
              labels: issue.fields.labels ?? [],
              assignee: issue.fields.assignee?.displayName ?? null,
            },
          });
        }
        nextPageToken = page.isLast ? undefined : page.nextPageToken;
      } while (nextPageToken && tickets.length < MAX_TICKETS_PER_SYNC);
      return tickets.slice(0, MAX_TICKETS_PER_SYNC);
    },

    async moveTicket(context, ticketKey, column) {
      const config = readJiraConfig(context.config);
      const key = encodeURIComponent(ticketKey);
      const { transitions } = await request<{ transitions?: JiraTransition[] }>(context, `/rest/api/3/issue/${key}/transitions`);
      const transition = pickJiraTransition(transitions ?? [], column, config.columnToStatus);
      if (!transition) {
        return null;
      }
      await request(context, `/rest/api/3/issue/${key}/transitions`, {
        method: 'POST',
        body: JSON.stringify({ transition: { id: transition.id } }),
      });
      return transition.to?.name ?? null;
    },

    async addComment(context, ticketKey, body) {
      // API v2 takes plain text, which avoids building ADF for a comment.
      await request(context, `/rest/api/2/issue/${encodeURIComponent(ticketKey)}/comment`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
    },
  };
}
