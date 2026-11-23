import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, kanbanDb, projectsDb } from '@/modules/database/index.js';
import kanbanMcpRoutes from '@/modules/kanban/kanban-mcp.routes.js';
import { getKanbanMcpToken, kanbanMcpService, resolveProjectFromDirectory } from '@/modules/kanban/services/kanban-mcp.service.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

async function withIsolatedDatabase(runTest: (workspace: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-mcp-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(tempDirectory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('the board is found from any directory inside the project, deepest project first', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const app = path.join(workspace, 'app');
    const worktree = path.join(app, '.worktrees', 'feature');
    await mkdir(path.join(app, 'src'), { recursive: true });
    await mkdir(worktree, { recursive: true });
    const parent = projectsDb.createProjectPath(app)!.project!.project_id;
    const child = projectsDb.createProjectPath(worktree)!.project!.project_id;
    assert.equal(resolveProjectFromDirectory(path.join(app, 'src')).projectId, parent);
    assert.equal(resolveProjectFromDirectory(worktree).projectId, child);
    assert.throws(() => resolveProjectFromDirectory(path.join(workspace, 'elsewhere')), /Aucun projet/);
  });
});

test('the tools create, find by ticket key, move and comment cards', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const projectId = projectsDb.createProjectPath(workspace)!.project!.project_id;
    const created = kanbanMcpService.callTool('kanban_create_card', {
      cwd: workspace,
      title: 'Exporter les commandes en CSV',
      description: '## À faire\n- bouton export',
    }) as { id: string; column: string };
    assert.equal(created.column, 'backlog');
    assert.match(kanbanDb.listComments(created.id)[0].body, /créée par un agent/);

    kanbanDb.upsertExternalCard({
      projectId, source: 'jira', externalId: '1', externalKey: 'SHOP-42', externalUrl: null, externalStatus: 'To Do',
      externalUpdatedAt: 't', externalMeta: {}, title: 'Pagination', description: '', columnKey: 'todo',
    });
    const listed = kanbanMcpService.callTool('kanban_list_cards', { cwd: workspace, query: 'csv' }) as Array<{ id: string }>;
    assert.deepEqual(listed.map((card) => card.id), [created.id]);

    const moved = kanbanMcpService.callTool('kanban_update_card', { cwd: workspace, card: 'shop-42', column: 'review' }) as { column: string };
    assert.equal(moved.column, 'review');
    kanbanMcpService.callTool('kanban_comment', { cwd: workspace, card: 'SHOP-42', body: 'Vu' });
    const card = kanbanMcpService.callTool('kanban_get_card', { cwd: workspace, card: 'SHOP-42' }) as { comments: Array<{ author: string; body: string }> };
    assert.equal(card.comments.at(-1)?.author, 'agent');
    assert.throws(() => kanbanMcpService.callTool('kanban_update_card', { cwd: workspace, card: 'nope' }), /introuvable/);
    assert.throws(() => kanbanMcpService.callTool('kanban_create_card', { cwd: workspace, title: 'x', column: 'later' }), /column must be/);
  });
});

/** Talks to the real MCP script over stdio, the way an agent CLI does. */
test('the MCP script speaks JSON-RPC over stdio and reaches the board through the routes', async () => {
  await withIsolatedDatabase(async (workspace) => {
    projectsDb.createProjectPath(workspace);
    const app = express();
    app.use(express.json());
    app.use('/api/kanban-mcp', kanbanMcpRoutes);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;

    const root = findApplicationRoot(getModuleDirectory(import.meta.url));
    const script = path.join(root, 'server', 'modules', 'kanban', 'kanban-mcp.ts');
    const child = spawn(path.join(root, 'node_modules', '.bin', 'tsx'), ['--tsconfig', path.join(root, 'server', 'tsconfig.json'), script], {
      cwd: workspace,
      env: {
        ...process.env,
        CLOUDCLI_KANBAN_MCP_TOKEN: getKanbanMcpToken(),
        CLOUDCLI_KANBAN_API_URL: `http://127.0.0.1:${port}/api/kanban-mcp`,
      },
    });
    const responses = new Map<number, Record<string, unknown>>();
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, index)) as { id: number };
        buffer = buffer.slice(index + 1);
        responses.set(message.id, message);
      }
    });
    const call = async (id: number, method: string, params: Record<string, unknown> = {}) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      for (let attempt = 0; attempt < 200 && !responses.has(id); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return responses.get(id) as { result?: Record<string, unknown>; error?: unknown };
    };

    try {
      const init = await call(1, 'initialize');
      assert.ok(init.result);
      assert.equal((init.result.serverInfo as { name: string }).name, 'cloudcli-kanban');
      const list = await call(2, 'tools/list');
      assert.ok(list.result);
      assert.ok((list.result.tools as Array<{ name: string }>).some((tool) => tool.name === 'kanban_create_card'));
      const created = await call(3, 'tools/call', { name: 'kanban_create_card', arguments: { title: 'Depuis le MCP', description: 'ok' } });
      assert.ok(created.result);
      const text = (created.result.content as Array<{ text: string }>)[0].text;
      assert.equal(JSON.parse(text).title, 'Depuis le MCP');
      const failed = await call(4, 'tools/call', { name: 'kanban_get_card', arguments: { card: 'missing' } });
      assert.equal(failed.result?.isError, true);
    } finally {
      child.kill();
      server.close();
    }
  });
});
