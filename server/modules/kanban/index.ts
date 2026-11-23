// The HTTP surface of project boards, mounted by the app under /api/kanban.
export { default as kanbanRoutes } from './kanban.routes.js';

// Started by the server at boot: installs the agent runner and recovers interrupted cards.
export { initializeKanbanAgents } from './kanban.module.js';

// The HTTP surface the cloudcli-kanban MCP process calls, mounted under /api/kanban-mcp (token-authenticated).
export { default as kanbanMcpRoutes } from './kanban-mcp.routes.js';

// Called by the server at boot: registers the kanban tools in each agent's MCP config.
export { registerKanbanAgentTools } from './services/kanban-mcp.service.js';
