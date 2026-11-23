// The HTTP surface of project boards, mounted by the app under /api/kanban.
export { default as kanbanRoutes } from './kanban.routes.js';

// Started by the server at boot: installs the agent runner and recovers interrupted cards.
export { initializeKanbanAgents } from './kanban.module.js';
