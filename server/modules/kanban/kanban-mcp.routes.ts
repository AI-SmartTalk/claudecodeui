import express from 'express';
import type { Request, Response } from 'express';

import { getKanbanMcpToken, kanbanMcpService } from '@/modules/kanban/services/kanban-mcp.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

function readBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

// The MCP process authenticates with its own token, not a user session:
// agents run outside the browser and must not hold a user JWT.
router.use((req, res, next) => {
  const token = readBearerToken(req.headers.authorization);
  if (!token || token !== getKanbanMcpToken()) {
    res.status(401).json({ success: false, error: 'Invalid Kanban MCP token.' });
    return;
  }
  next();
});

router.post(
  '/tools/:toolName',
  asyncHandler(async (req: Request, res: Response) => {
    const toolName = req.params.toolName;
    if (typeof toolName !== 'string' || !toolName) {
      throw new AppError('toolName is required.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }
    const input = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    res.json(createApiSuccessResponse(kanbanMcpService.callTool(toolName, input)));
  }),
);

export default router;
