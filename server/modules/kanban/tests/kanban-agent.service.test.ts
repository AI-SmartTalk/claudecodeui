import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, kanbanDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { createKanbanAgentRunner } from '@/modules/kanban/services/kanban-agent.service.js';
import type { KanbanAgentDependencies } from '@/modules/kanban/services/kanban-agent.service.js';
import { kanbanService, setKanbanAgentRunner } from '@/modules/kanban/services/kanban.service.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    setKanbanAgentRunner(null);
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type PendingTurn = {
  input: Parameters<KanbanAgentDependencies['runTurn']>[0];
  resolve(result: { started: boolean; error: string | null }): void;
};

/** A fake runtime whose turns stay open until the test settles them. */
function createFakeDependencies() {
  const turns: PendingTurn[] = [];
  let sessionCounter = 0;
  const sessions = new Set<string>();
  const dependencies: KanbanAgentDependencies = {
    runTurn: (input) => new Promise((resolve) => {
      turns.push({ input, resolve });
    }),
    abortSession: async () => true,
    isSessionBusy: () => false,
    sessionExists: (sessionId) => sessions.has(sessionId),
    createSession: (provider, projectPath, title) => {
      sessionCounter += 1;
      const id = `session-${sessionCounter}`;
      sessions.add(id);
      sessionsDb.createAppSession(id, provider, projectPath, title);
      return id;
    },
    getDefaultModel: async () => 'opus',
    readLastAssistantMessage: async () => 'Fait. Pour tester : ouvrir la page.',
    getProjectPath: (projectId) => projectsDb.getProjectPathById(projectId),
  };
  return { dependencies, turns };
}

/** Lets the runner's background settle chain run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

function createProject(): string {
  const created = projectsDb.createProjectPath('/workspace/board');
  assert.ok(created.project);
  return created.project.project_id;
}

test('a run moves the card to review with the agent reply and the default model', async () => {
  await withIsolatedDatabase(async () => {
    const { dependencies, turns } = createFakeDependencies();
    const runner = createKanbanAgentRunner(dependencies);
    setKanbanAgentRunner(runner);
    const projectId = createProject();
    const card = kanbanService.createCard(projectId, {
      title: 'Ajouter le mode sombre',
      description: 'Sur la page réglages',
      column: 'todo',
      provider: 'claude',
      model: null,
      attachments: [],
    });

    const started = await kanbanService.startRun(card.id, { userId: 1, newSession: false });
    assert.equal(started.agentStatus, 'running');
    assert.equal(started.column, 'in_progress');
    assert.equal(started.activeSessionId, 'session-1');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].input.options.model, 'opus');
    assert.equal(turns[0].input.options.permissionMode, 'bypassPermissions');
    assert.match(turns[0].input.content, /Ajouter le mode sombre/);
    assert.match(turns[0].input.content, /Sur la page réglages/);

    turns[0].resolve({ started: true, error: null });
    await flush();

    const settled = kanbanService.getCard(card.id);
    assert.equal(settled.agentStatus, 'idle');
    assert.equal(settled.column, 'review');
    assert.equal(settled.comments.at(-1)?.author, 'agent');
    assert.match(settled.comments.at(-1)?.body ?? '', /Pour tester/);
  });
});

test('a comment relaunches the agent in the same conversation, with the chosen model', async () => {
  await withIsolatedDatabase(async () => {
    const { dependencies, turns } = createFakeDependencies();
    setKanbanAgentRunner(createKanbanAgentRunner(dependencies));
    const projectId = createProject();
    const card = kanbanService.createCard(projectId, {
      title: 'Bug login', description: '', column: 'todo', provider: 'claude', model: 'sonnet', attachments: [],
    });
    await kanbanService.startRun(card.id, { userId: 1, newSession: false });
    turns[0].resolve({ started: true, error: null });
    await flush();

    await kanbanService.addComment(card.id, { body: 'Le bouton est encore gris', attachments: [], relaunch: true, userId: 1 });
    assert.equal(turns.length, 2);
    assert.equal(turns[1].input.sessionId, 'session-1');
    assert.equal(turns[1].input.options.model, 'sonnet');
    assert.match(turns[1].input.content, /Le bouton est encore gris/);
    assert.equal(kanbanService.getCard(card.id).agentStatus, 'running');
  });
});

test('a comment written while the agent works is sent right after the run ends', async () => {
  await withIsolatedDatabase(async () => {
    const { dependencies, turns } = createFakeDependencies();
    setKanbanAgentRunner(createKanbanAgentRunner(dependencies));
    const projectId = createProject();
    const card = kanbanService.createCard(projectId, {
      title: 'Tâche', description: '', column: 'todo', provider: 'claude', model: null, attachments: [],
    });
    await kanbanService.startRun(card.id, { userId: 1, newSession: false });
    await kanbanService.addComment(card.id, { body: 'Pense aussi au mobile', attachments: [], relaunch: true, userId: 1 });
    assert.equal(turns.length, 1, 'no second run while the first is going');

    turns[0].resolve({ started: true, error: null });
    await flush();
    assert.equal(turns.length, 2);
    assert.match(turns[1].input.content, /Pense aussi au mobile/);
  });
});

test('a failed run sends the card back to todo with the reason', async () => {
  await withIsolatedDatabase(async () => {
    const { dependencies, turns } = createFakeDependencies();
    setKanbanAgentRunner(createKanbanAgentRunner(dependencies));
    const projectId = createProject();
    const card = kanbanService.createCard(projectId, {
      title: 'Tâche', description: '', column: 'todo', provider: 'claude', model: null, attachments: [],
    });
    await kanbanService.startRun(card.id, { userId: 1, newSession: false });
    turns[0].resolve({ started: true, error: 'quota dépassé' });
    await flush();

    const settled = kanbanService.getCard(card.id);
    assert.equal(settled.agentStatus, 'failed');
    assert.equal(settled.agentError, 'quota dépassé');
    assert.equal(settled.column, 'todo');
  });
});

test('queued cards of a project run one after the other', async () => {
  await withIsolatedDatabase(async () => {
    const { dependencies, turns } = createFakeDependencies();
    setKanbanAgentRunner(createKanbanAgentRunner(dependencies));
    const projectId = createProject();
    const first = kanbanService.createCard(projectId, {
      title: 'Première', description: '', column: 'todo', provider: 'claude', model: null, attachments: [],
    });
    const second = kanbanService.createCard(projectId, {
      title: 'Deuxième', description: '', column: 'todo', provider: 'claude', model: null, attachments: [],
    });

    const { queued } = await kanbanService.queueCards(projectId, { column: 'todo' });
    assert.equal(queued, 2);
    assert.equal(turns.length, 1);
    assert.match(turns[0].input.content, /Première/);
    assert.equal(kanbanService.getCard(second.id).agentStatus, 'queued');

    turns[0].resolve({ started: true, error: null });
    await flush();
    assert.equal(turns.length, 2);
    assert.match(turns[1].input.content, /Deuxième/);
    assert.equal(kanbanService.getCard(first.id).column, 'review');
  });
});

test('stopping a run leaves the card idle and a late settle does not move it', async () => {
  await withIsolatedDatabase(async () => {
    const { dependencies, turns } = createFakeDependencies();
    setKanbanAgentRunner(createKanbanAgentRunner(dependencies));
    const projectId = createProject();
    const card = kanbanService.createCard(projectId, {
      title: 'Tâche', description: '', column: 'todo', provider: 'claude', model: null, attachments: [],
    });
    await kanbanService.startRun(card.id, { userId: 1, newSession: false });
    const stopped = await kanbanService.stopRun(card.id);
    assert.equal(stopped.agentStatus, 'idle');
    assert.equal(stopped.column, 'todo');

    turns[0].resolve({ started: true, error: null });
    await flush();
    const after = kanbanService.getCard(card.id);
    assert.equal(after.column, 'todo');
    assert.ok(!after.comments.some((comment) => comment.author === 'agent'));
  });
});

test('recover marks cards left running as interrupted', async () => {
  await withIsolatedDatabase(async () => {
    const projectId = createProject();
    const card = kanbanDb.createCard({
      projectId, title: 'Tâche', description: '', columnKey: 'in_progress', provider: 'claude', model: null, attachments: [],
    });
    kanbanDb.updateCard(card.id, { agentStatus: 'running' });

    const { dependencies } = createFakeDependencies();
    await createKanbanAgentRunner(dependencies).recover();
    const recovered = kanbanDb.getCard(card.id);
    assert.equal(recovered?.agent_status, 'failed');
    assert.equal(recovered?.column_key, 'todo');
  });
});

test('moving a card to another column puts it at the bottom and deleting removes its thread', async () => {
  await withIsolatedDatabase(async () => {
    const projectId = createProject();
    const a = kanbanService.createCard(projectId, {
      title: 'A', description: '', column: 'todo', provider: 'claude', model: null, attachments: [],
    });
    const b = kanbanService.createCard(projectId, {
      title: 'B', description: '', column: 'backlog', provider: 'claude', model: null, attachments: [],
    });
    const moved = kanbanService.updateCard(b.id, { column: 'todo' });
    assert.ok(moved.position > a.position);

    kanbanDb.addComment({ cardId: b.id, author: 'user', body: 'x' });
    await kanbanService.deleteCard(b.id);
    assert.equal(kanbanDb.getCard(b.id), null);
    assert.equal(kanbanDb.listComments(b.id).length, 0);
    assert.equal(kanbanService.listBoard(projectId).cards.length, 1);
  });
});
