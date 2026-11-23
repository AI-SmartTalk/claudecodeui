import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, kanbanDb, projectsDb } from '@/modules/database/index.js';
import {
  adfToMarkdown,
  buildJiraQuery,
  createJiraCloudConnector,
  pickJiraTransition,
} from '@/modules/kanban/connectors/jira-cloud.connector.js';
import { createKanbanSyncService } from '@/modules/kanban/services/kanban-sync.service.js';
import { kanbanService, setKanbanRuntime } from '@/modules/kanban/services/kanban.service.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-sync-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    setKanbanRuntime({ sync: null });
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type JiraIssueFixture = {
  id: string; key: string; summary: string; status: string; category: string; updated: string;
  attachments?: Array<{ id: string; filename: string; mimeType: string; size: number }>;
};

/** A tiny in-memory Jira Cloud answering the endpoints the connector calls. */
function createFakeJira(issues: JiraIssueFixture[]) {
  const calls: Array<{ method: string; path: string; body: unknown; auth: string | null }> = [];
  const statuses: Record<string, { id: string; name: string; category: string }> = {
    todo: { id: '11', name: 'To Do', category: 'new' },
    progress: { id: '21', name: 'In Progress', category: 'indeterminate' },
    review: { id: '31', name: 'In Review', category: 'indeterminate' },
    done: { id: '41', name: 'Done', category: 'done' },
  };
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname, body, auth: (init.headers as Record<string, string>).Authorization ?? null });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

    if (url.pathname === '/rest/api/3/myself') return json({ displayName: 'Odran' });
    if (url.pathname === '/rest/api/3/project/APP/statuses') {
      return json([{ statuses: Object.values(statuses).map((s) => ({ name: s.name, statusCategory: { key: s.category } })) }]);
    }
    if (url.pathname === '/rest/api/3/search/jql') {
      return json({
        isLast: true,
        issues: issues.map((issue) => ({
          id: issue.id,
          key: issue.key,
          fields: {
            summary: issue.summary,
            description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Détails ${issue.key}` }] }] },
            status: { name: issue.status, statusCategory: { key: issue.category } },
            priority: { name: 'High' },
            issuetype: { name: 'Bug' },
            labels: ['front'],
            updated: issue.updated,
            attachment: issue.attachments ?? [],
          },
        })),
      });
    }
    const transitionsMatch = url.pathname.match(/^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/);
    if (transitionsMatch && method === 'GET') {
      return json({
        transitions: Object.values(statuses).map((s) => ({ id: s.id, name: `Go ${s.name}`, to: { name: s.name, statusCategory: { key: s.category } } })),
      });
    }
    if (transitionsMatch && method === 'POST') return new Response(null, { status: 204 });
    const attachmentMatch = url.pathname.match(/^\/rest\/api\/3\/attachment\/content\/(.+)$/);
    if (attachmentMatch) return new Response(`bytes-of-${attachmentMatch[1]}`, { status: 200 });
    if (/^\/rest\/api\/2\/issue\/[^/]+\/comment$/.test(url.pathname)) return json({ id: 'c1' }, 201);
    return json({ errorMessages: ['not found'] }, 404);
  };
  return { fetchImpl, calls };
}

const JIRA_CONFIG = { baseUrl: 'https://acme.atlassian.net', email: 'me@acme.io', projectKey: 'APP' };

function linkJira(projectId: string, extra: Record<string, unknown> = {}) {
  kanbanDb.saveConnector({ projectId, type: 'jira', config: { ...JIRA_CONFIG, ...extra }, secret: 'tok', enabled: true });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

test('adfToMarkdown keeps the structure an agent needs', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Contexte' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Voir ' }, { type: 'text', text: 'la doc', marks: [{ type: 'link', attrs: { href: 'https://x.io' } }] }] },
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'un', marks: [{ type: 'strong' }] }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'deux' }] }] },
      ] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1;' }] },
    ],
  };
  assert.equal(adfToMarkdown(doc), '## Contexte\n\nVoir [la doc](https://x.io)\n\n- **un**\n- deux\n\n```ts\nconst a = 1;\n```');
  assert.equal(adfToMarkdown(null), '');
});

test('buildJiraQuery defaults to the open tickets of the project', () => {
  assert.equal(buildJiraQuery({ projectKey: 'APP', jql: null, importDone: false }), 'project = "APP" AND statusCategory != Done ORDER BY updated DESC');
  assert.equal(buildJiraQuery({ projectKey: 'APP', jql: 'assignee = currentUser()', importDone: false }), 'assignee = currentUser()');
});

test('pickJiraTransition matches review and in-progress by name, and honours an explicit mapping', () => {
  const transitions = [
    { id: '1', name: 'a', to: { name: 'In Review', statusCategory: { key: 'indeterminate' } } },
    { id: '2', name: 'b', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    { id: '3', name: 'c', to: { name: 'Done', statusCategory: { key: 'done' } } },
    { id: '4', name: 'd', to: { name: 'Backlog', statusCategory: { key: 'new' } } },
  ];
  assert.equal(pickJiraTransition(transitions, 'review', {})?.id, '1');
  assert.equal(pickJiraTransition(transitions, 'in_progress', {})?.id, '2');
  assert.equal(pickJiraTransition(transitions, 'done', {})?.id, '3');
  assert.equal(pickJiraTransition(transitions, 'todo', {})?.id, '4');
  assert.equal(pickJiraTransition(transitions, 'in_progress', { in_progress: 'in review' })?.id, '1');
  assert.equal(pickJiraTransition(transitions.slice(1), 'review', {}), null);
});

test('a sync imports tickets into mapped columns and only moves them when Jira status changes', async () => {
  await withIsolatedDatabase(async () => {
    const projectId = projectsDb.createProjectPath('/workspace/jira')!.project!.project_id;
    const issues: JiraIssueFixture[] = [
      { id: '1', key: 'APP-1', summary: 'Bug pagination', status: 'To Do', category: 'new', updated: 't1' },
      { id: '2', key: 'APP-2', summary: 'Refonte login', status: 'In Progress', category: 'indeterminate', updated: 't1' },
    ];
    const jira = createFakeJira(issues);
    const sync = createKanbanSyncService([createJiraCloudConnector(jira.fetchImpl)]);
    setKanbanRuntime({ sync });
    linkJira(projectId, { statusMapping: { 'To Do': 'todo' } });

    assert.deepEqual(await kanbanService.syncConnector(projectId), { created: 2, updated: 0, total: 2 });
    const board = kanbanService.listBoard(projectId).cards;
    const app1 = board.find((card) => card.external?.key === 'APP-1')!;
    assert.equal(app1.column, 'todo');
    assert.equal(app1.description, 'Détails APP-1');
    assert.equal(app1.external?.url, 'https://acme.atlassian.net/browse/APP-1');
    assert.equal(app1.external?.priority, 'High');
    assert.deepEqual(app1.external?.labels, ['front']);
    assert.equal(board.find((card) => card.external?.key === 'APP-2')!.column, 'in_progress');
    assert.match(jira.calls.find((call) => call.path === '/rest/api/3/search/jql')!.auth ?? '', /^Basic /);

    // Nothing changed in Jira: nothing changes on the board, even after a local move.
    kanbanService.updateCard(app1.id, { column: 'backlog' });
    await flush();
    issues[0].status = 'To Do';
    assert.deepEqual(await kanbanService.syncConnector(projectId), { created: 0, updated: 0, total: 2 });
    assert.equal(kanbanService.getCard(app1.id).column, 'backlog');

    // The ticket moved in Jira: the card follows.
    issues[0].status = 'Done';
    issues[0].category = 'done';
    issues[0].updated = 't2';
    await kanbanService.syncConnector(projectId);
    assert.equal(kanbanService.getCard(app1.id).column, 'done');
    assert.equal(kanbanService.getConnector(projectId)?.lastSyncCount, 2);
    assert.equal(kanbanService.getConnector(projectId)?.hasSecret, true);
    assert.equal('secret' in (kanbanService.getConnector(projectId) as object), false);
  });
});

test('moving a linked card transitions its ticket, and the agent reply is posted as a comment', async () => {
  await withIsolatedDatabase(async () => {
    const projectId = projectsDb.createProjectPath('/workspace/jira')!.project!.project_id;
    const jira = createFakeJira([{ id: '7', key: 'APP-7', summary: 'Tâche', status: 'To Do', category: 'new', updated: 't1' }]);
    const sync = createKanbanSyncService([createJiraCloudConnector(jira.fetchImpl)]);
    setKanbanRuntime({ sync });
    linkJira(projectId);
    await kanbanService.syncConnector(projectId);
    const card = kanbanService.listBoard(projectId).cards[0];

    kanbanService.updateCard(card.id, { column: 'review' });
    await flush();
    const post = jira.calls.find((call) => call.method === 'POST' && call.path.endsWith('/transitions'));
    assert.deepEqual(post?.body, { transition: { id: '31' } });
    assert.equal(kanbanService.getCard(card.id).external?.status, 'In Review');

    await sync.onAgentReply(card.id, 'Corrigé, tester la page 2.');
    const comment = jira.calls.find((call) => call.path === '/rest/api/2/issue/APP-7/comment');
    assert.ok(comment);
    assert.match(String((comment.body as { body: string }).body), /Agent CloudCLI[\s\S]*tester la page 2/);
  });
});

test('pushes can be turned off, and a failed push is noted on the card instead of throwing', async () => {
  await withIsolatedDatabase(async () => {
    const projectId = projectsDb.createProjectPath('/workspace/jira')!.project!.project_id;
    const jira = createFakeJira([{ id: '8', key: 'APP-8', summary: 'Tâche', status: 'To Do', category: 'new', updated: 't1' }]);
    const sync = createKanbanSyncService([createJiraCloudConnector(jira.fetchImpl)]);
    setKanbanRuntime({ sync });
    linkJira(projectId, { pushStatus: false });
    await kanbanService.syncConnector(projectId);
    const card = kanbanService.listBoard(projectId).cards[0];
    kanbanService.updateCard(card.id, { column: 'done' });
    await flush();
    assert.equal(jira.calls.some((call) => call.method === 'POST'), false);

    const failing = createKanbanSyncService([createJiraCloudConnector(async () => new Response('{"errorMessages":["boom"]}', { status: 500 }))]);
    linkJira(projectId, { pushStatus: true });
    await failing.onCardMoved(card.id, 'review');
    assert.match(kanbanService.getCard(card.id).comments.at(-1)?.body ?? '', /Impossible de déplacer APP-8.*boom/);
  });
});

test('connector settings are validated and rejected credentials read clearly', async () => {
  await withIsolatedDatabase(async () => {
    const projectId = projectsDb.createProjectPath('/workspace/jira')!.project!.project_id;
    const unauthorized = createKanbanSyncService([createJiraCloudConnector(async () => new Response('', { status: 401 }))]);
    setKanbanRuntime({ sync: unauthorized });
    await assert.rejects(
      kanbanService.testConnector(projectId, { type: 'jira', config: { ...JIRA_CONFIG, baseUrl: 'http://insecure' }, secret: 't' }),
      /Adresse Jira invalide/,
    );
    await assert.rejects(
      kanbanService.testConnector(projectId, { type: 'jira', config: JIRA_CONFIG, secret: 't' }),
      /refuse ces identifiants/,
    );
    assert.throws(() => kanbanService.saveConnector(projectId, { type: 'jira', config: JIRA_CONFIG, enabled: true }), /token API est requis/);

    const jira = createFakeJira([]);
    setKanbanRuntime({ sync: createKanbanSyncService([createJiraCloudConnector(jira.fetchImpl)]) });
    const result = await kanbanService.testConnector(projectId, { type: 'jira', config: JIRA_CONFIG, secret: 't' });
    assert.equal(result.account, 'Odran');
    assert.deepEqual(
      result.statuses.map((status) => `${status.name}:${status.column}`),
      ['To Do:backlog', 'In Progress:in_progress', 'In Review:in_progress', 'Done:done'],
    );
  });
});

test('ticket attachments are copied once into the upload store and given to the card', async () => {
  await withIsolatedDatabase(async () => {
    const projectId = projectsDb.createProjectPath('/workspace/jira')!.project!.project_id;
    const issues: JiraIssueFixture[] = [{
      id: '9', key: 'APP-9', summary: 'Maquette', status: 'To Do', category: 'new', updated: 't1',
      attachments: [
        { id: 'a1', filename: 'maquette login.png', mimeType: 'image/png', size: 12 },
        { id: 'a2', filename: 'huge.mov', mimeType: 'video/quicktime', size: 50 * 1024 * 1024 },
      ],
    }];
    const jira = createFakeJira(issues);
    const stored: Array<{ name: string; data: string }> = [];
    const sync = createKanbanSyncService([createJiraCloudConnector(jira.fetchImpl)], async (name, data) => {
      stored.push({ name, data: data.toString() });
      return `/assets/${name}`;
    });
    setKanbanRuntime({ sync });
    linkJira(projectId);

    await kanbanService.syncConnector(projectId);
    const card = kanbanService.listBoard(projectId).cards[0];
    const imported = card.attachments as Array<{ path: string; name: string; mimeType?: string }>;
    kanbanService.updateCard(card.id, { attachments: [...imported, { path: '/assets/local.png', name: 'local.png' }] });
    assert.deepEqual(stored, [{ name: 'jira-a1-maquette_login.png', data: 'bytes-of-a1' }]);
    assert.equal(imported[0].path, '/assets/jira-a1-maquette_login.png');
    assert.equal(imported[0].mimeType, 'image/png');

    // The ticket changes: the same attachment is not downloaded twice, and local files stay.
    issues[0].updated = 't2';
    await kanbanService.syncConnector(projectId);
    assert.equal(stored.length, 1);
    const after = kanbanService.getCard(card.id).attachments as Array<{ name: string }>;
    assert.deepEqual(after.map((attachment) => attachment.name), ['maquette login.png', 'local.png']);
  });
});
