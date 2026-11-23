import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { appConfigDb, kanbanDb, projectsDb } from '@/modules/database/index.js';
import type { KanbanCardRow, KanbanColumnKey } from '@/modules/database/index.js';
import { KANBAN_COLUMNS, kanbanService } from '@/modules/kanban/services/kanban.service.js';
import { providerMcpService } from '@/modules/providers/index.js';
import { AppError, findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

/** Name the tools are registered under in each agent's MCP config. */
export const KANBAN_MCP_SERVER_NAME = 'cloudcli-kanban';

const TOKEN_CONFIG_KEY = 'kanban_mcp_token';

/** Longest description excerpt returned by kanban_list_cards. */
const LIST_EXCERPT_LENGTH = 240;

/** The token the MCP process presents; generated once and kept in app config. */
export function getKanbanMcpToken(): string {
  const existing = appConfigDb.get(TOKEN_CONFIG_KEY);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  appConfigDb.set(TOKEN_CONFIG_KEY, token);
  return token;
}

function realpathOrSelf(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * The project whose directory contains `cwd` (the deepest one, so a worktree
 * project wins over its parent). The agent's MCP process runs in the project
 * it works on, which is how a tool call finds its board without being told.
 */
export function resolveProjectFromDirectory(cwd: string): { projectId: string; projectPath: string } {
  const target = realpathOrSelf(path.resolve(cwd));
  let best: { projectId: string; projectPath: string; depth: number } | null = null;
  for (const project of projectsDb.getProjectPaths()) {
    const projectPath = realpathOrSelf(project.project_path);
    if (target === projectPath || target.startsWith(`${projectPath}${path.sep}`)) {
      const depth = projectPath.length;
      if (!best || depth > best.depth) {
        best = { projectId: project.project_id, projectPath: project.project_path, depth };
      }
    }
  }
  if (!best) {
    throw new AppError(`Aucun projet CloudCLI ne contient le dossier ${cwd}.`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }
  return { projectId: best.projectId, projectPath: best.projectPath };
}

function findCard(projectId: string, reference: unknown): KanbanCardRow {
  const value = typeof reference === 'string' ? reference.trim() : '';
  if (!value) {
    throw new AppError('card is required.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  const cards = kanbanDb.listCards(projectId);
  const card = cards.find((candidate) => candidate.id === value)
    ?? cards.find((candidate) => candidate.external_key?.toLowerCase() === value.toLowerCase());
  if (!card) {
    throw new AppError(`Carte « ${value} » introuvable sur ce tableau.`, { code: 'KANBAN_CARD_NOT_FOUND', statusCode: 404 });
  }
  return card;
}

function readColumn(value: unknown, fallback?: KanbanColumnKey): KanbanColumnKey | undefined {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !KANBAN_COLUMNS.includes(value as KanbanColumnKey)) {
    throw new AppError(`column must be one of ${KANBAN_COLUMNS.join(', ')}.`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return value as KanbanColumnKey;
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function summarize(card: KanbanCardRow) {
  const description = card.description.replace(/\s+/g, ' ').trim();
  return {
    id: card.id,
    key: card.external_key,
    title: card.title,
    column: card.column_key,
    agentStatus: card.agent_status,
    description: description.length > LIST_EXCERPT_LENGTH ? `${description.slice(0, LIST_EXCERPT_LENGTH)}…` : description,
  };
}

/**
 * The tools behind the `cloudcli-kanban` MCP server. Consumed by the
 * kanban-mcp routes, which authenticate the MCP process and forward each call.
 */
export const kanbanMcpService = {
  callTool(toolName: string, input: Record<string, unknown>): unknown {
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : '';
    if (!cwd) {
      throw new AppError('cwd is required.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }
    const { projectId } = resolveProjectFromDirectory(cwd);

    switch (toolName) {
      case 'kanban_list_cards': {
        const column = readColumn(input.column);
        const query = readText(input.query)?.toLowerCase();
        return kanbanDb.listCards(projectId)
          .filter((card) => !column || card.column_key === column)
          .filter((card) => !query || `${card.title} ${card.description} ${card.external_key ?? ''}`.toLowerCase().includes(query))
          .map(summarize);
      }
      case 'kanban_get_card': {
        const card = findCard(projectId, input.card);
        const details = kanbanService.getCard(card.id);
        return {
          ...details,
          attachments: details.attachments.map((attachment) => (attachment as { name?: string }).name ?? 'file'),
        };
      }
      case 'kanban_create_card': {
        const title = readText(input.title);
        if (!title) {
          throw new AppError('title is required.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
        }
        const created = kanbanService.createCard(projectId, {
          title: title.trim().slice(0, 300),
          description: readText(input.description) ?? '',
          column: readColumn(input.column, 'backlog') as KanbanColumnKey,
          provider: 'claude',
          model: readText(input.model)?.trim() ?? null,
          attachments: [],
        });
        kanbanDb.addComment({ cardId: created.id, author: 'system', body: 'Carte créée par un agent.', delivered: true });
        return { id: created.id, title: created.title, column: created.column };
      }
      case 'kanban_update_card': {
        const card = findCard(projectId, input.card);
        const updated = kanbanService.updateCard(card.id, {
          title: readText(input.title)?.trim().slice(0, 300),
          description: typeof input.description === 'string' ? input.description : undefined,
          column: readColumn(input.column),
        });
        return summarize(kanbanDb.getCard(updated.id) as KanbanCardRow);
      }
      case 'kanban_comment': {
        const card = findCard(projectId, input.card);
        const body = readText(input.body);
        if (!body) {
          throw new AppError('body is required.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
        }
        const comment = kanbanDb.addComment({ cardId: card.id, author: 'agent', body, delivered: true });
        return { id: comment.id, card: card.id };
      }
      default:
        throw new AppError(`Unknown tool ${toolName}.`, { code: 'UNKNOWN_TOOL', statusCode: 404 });
    }
  },
};

/**
 * How agents start the MCP process: the compiled script with node when the
 * server runs from a build, the TypeScript source through the repo's tsx when
 * it runs from source. Never the globally installed `cloudcli`, which may be a
 * different version than the server answering the calls.
 */
function resolveMcpCommand(): { command: string; args: string[] } | null {
  const moduleDirectory = getModuleDirectory(import.meta.url);
  // The service lives in services/, the script one level up.
  const scriptDirectory = path.dirname(moduleDirectory);
  const compiled = path.join(scriptDirectory, 'kanban-mcp.js');
  if (existsSync(compiled)) {
    return { command: process.execPath, args: [compiled] };
  }
  const source = path.join(scriptDirectory, 'kanban-mcp.ts');
  const root = findApplicationRoot(moduleDirectory);
  const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
  if (existsSync(source) && existsSync(tsx)) {
    // An absolute tsconfig: a server started with `tsx --tsconfig server/tsconfig.json`
    // leaks that relative path to every child through TSX_TSCONFIG_PATH, and the
    // MCP process runs from the project directory, where it does not resolve.
    return { command: tsx, args: ['--tsconfig', path.join(root, 'server', 'tsconfig.json'), source] };
  }
  return null;
}

function mcpApiUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  return `http://127.0.0.1:${port}/api/kanban-mcp`;
}

/**
 * Makes the kanban tools available to every agent (user-scope MCP config of
 * each provider). Called at boot; it only writes when the registration is
 * missing or points elsewhere, because the agent CLIs also write those files.
 */
export async function registerKanbanAgentTools(): Promise<void> {
  const command = resolveMcpCommand();
  if (!command) {
    console.warn('[Kanban] MCP script not found; agents will not get the kanban tools.');
    return;
  }
  const env = { CLOUDCLI_KANBAN_MCP_TOKEN: getKanbanMcpToken(), CLOUDCLI_KANBAN_API_URL: mcpApiUrl() };
  const existing = await providerMcpService
    .listProviderMcpServersForScope('claude', 'user')
    .then((servers) => servers.find((server) => server.name === KANBAN_MCP_SERVER_NAME))
    .catch(() => undefined);
  const upToDate = existing
    && existing.command === command.command
    && JSON.stringify(existing.args ?? []) === JSON.stringify(command.args)
    && existing.env?.CLOUDCLI_KANBAN_MCP_TOKEN === env.CLOUDCLI_KANBAN_MCP_TOKEN
    && existing.env?.CLOUDCLI_KANBAN_API_URL === env.CLOUDCLI_KANBAN_API_URL;
  if (upToDate) {
    return;
  }
  const results = await providerMcpService.addMcpServerToAllProviders({
    name: KANBAN_MCP_SERVER_NAME,
    scope: 'user',
    transport: 'stdio',
    command: command.command,
    args: command.args,
    env,
  });
  const failed = results.filter((result) => !result.created);
  if (failed.length > 0) {
    console.warn('[Kanban] MCP registration incomplete', failed);
  }
}
