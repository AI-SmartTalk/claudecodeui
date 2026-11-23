#!/usr/bin/env node
// MCP stdio server that lets an agent read and fill the project's kanban board.
//
// Spawned by the agent CLI (Claude, Codex…) with the project as working
// directory; every tool call is forwarded to the CloudCLI server, which
// resolves the board from that directory. Deliberately dependency-free so it
// starts fast and runs from source (tsx) or compiled (node) alike.

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const apiUrl = (process.env.CLOUDCLI_KANBAN_API_URL || 'http://127.0.0.1:3001/api/kanban-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_KANBAN_MCP_TOKEN || '';
const API_TIMEOUT_MS = 30_000;

const COLUMN_SCHEMA = {
  type: 'string',
  enum: ['backlog', 'todo', 'in_progress', 'review', 'done'],
  description: 'Board column: backlog (not planned), todo (ready for an agent), in_progress, review (to test), done.',
};

const CARD_REF_SCHEMA = {
  type: 'string',
  description: 'Card id, or the ticket key of an imported card (e.g. SHOP-42).',
};

const tools: ToolDefinition[] = [
  {
    name: 'kanban_list_cards',
    description: 'List the cards of the kanban board of the current project (id, ticket key, title, column, agent status, short description). Use it before creating cards to avoid duplicates.',
    inputSchema: {
      type: 'object',
      properties: {
        column: COLUMN_SCHEMA,
        query: { type: 'string', description: 'Optional text to filter titles and descriptions.' },
      },
    },
  },
  {
    name: 'kanban_get_card',
    description: 'Read one card in full: description, comments, attachments, linked conversations.',
    inputSchema: { type: 'object', properties: { card: CARD_REF_SCHEMA }, required: ['card'] },
  },
  {
    name: 'kanban_create_card',
    description: 'Create a card on the board of the current project. Write the description in markdown: context, what to do, acceptance criteria, how to test, files involved. New cards go to the backlog unless a column is given.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative title (one line).' },
        description: { type: 'string', description: 'Markdown description of the work.' },
        column: COLUMN_SCHEMA,
        model: { type: 'string', description: 'Optional model the agent should use for this card (e.g. opus, sonnet). Omit for the default.' },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'kanban_update_card',
    description: 'Update a card: title, description or column. Moving a card linked to Jira also moves its ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        card: CARD_REF_SCHEMA,
        title: { type: 'string' },
        description: { type: 'string' },
        column: COLUMN_SCHEMA,
      },
      required: ['card'],
    },
  },
  {
    name: 'kanban_comment',
    description: 'Add a comment to a card, as the agent. It does not relaunch any agent.',
    inputSchema: {
      type: 'object',
      properties: { card: CARD_REF_SCHEMA, body: { type: 'string', description: 'Markdown comment.' } },
      required: ['card', 'body'],
    },
  },
];

async function callKanbanApi(toolName: string, input: Record<string, unknown>): Promise<unknown> {
  if (!apiToken) {
    throw new Error('CLOUDCLI_KANBAN_MCP_TOKEN is not configured.');
  }
  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    // The server finds the board from the directory the agent works in.
    body: JSON.stringify({ ...input, cwd: process.cwd() }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({})) as { success?: boolean; data?: unknown; error?: unknown };
  if (!response.ok || data.success === false) {
    const error = data.error as { message?: string } | string | undefined;
    throw new Error((typeof error === 'string' ? error : error?.message) || `Kanban API request failed (${response.status})`);
  }
  return data.data;
}

async function handleMessage(message: JsonRpcRequest): Promise<unknown> {
  if (message.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cloudcli-kanban', version: '1.0.0' },
    };
  }
  if (message.method === 'tools/list') {
    return { tools };
  }
  if (message.method === 'tools/call') {
    const params = message.params || {};
    const name = typeof params.name === 'string' ? params.name : '';
    if (!tools.some((tool) => tool.name === name)) {
      throw new Error(`Unknown tool: ${name}`);
    }
    const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
    try {
      const result = await callKanbanApi(name, args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      // A tool error the model can read and recover from, rather than a protocol failure.
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
  if (message.method.startsWith('notifications/')) {
    return undefined;
  }
  throw new Error(`Unsupported method: ${message.method}`);
}

function writeMessage(message: Record<string, unknown>): void {
  // MCP stdio: one JSON-RPC message per line.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const raw = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!raw) continue;
    void (async () => {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(raw) as JsonRpcRequest;
      } catch (error) {
        writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error) } });
        return;
      }
      try {
        const result = await handleMessage(request);
        if (request.id !== undefined) writeMessage({ jsonrpc: '2.0', id: request.id, result });
      } catch (error) {
        if (request.id !== undefined) {
          writeMessage({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
          });
        }
      }
    })();
  }
});
