import express from 'express';
import type { Request, Response } from 'express';

import type { KanbanColumnKey } from '@/modules/database/index.js';
import {
  KANBAN_COLUMNS,
  KANBAN_PROVIDERS,
  kanbanService,
} from '@/modules/kanban/services/kanban.service.js';
import type { KanbanCardUpdateInput } from '@/modules/kanban/services/kanban.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

/** Longest title accepted; a card title is a one-liner on the board. */
const MAX_TITLE_LENGTH = 300;

function invalid(message: string): AppError {
  return new AppError(message, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
}

function readUserId(request: Request): number | null {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  return Number.isInteger(userId) ? userId : null;
}

function readBody(request: Request): Record<string, unknown> {
  const body: unknown = request.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function readParam(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(`${name} is required.`);
  }
  return value;
}

function readTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid('title is required.');
  }
  return value.trim().slice(0, MAX_TITLE_LENGTH);
}

function readColumn(value: unknown): KanbanColumnKey {
  if (typeof value !== 'string' || !KANBAN_COLUMNS.includes(value as KanbanColumnKey)) {
    throw invalid(`column must be one of ${KANBAN_COLUMNS.join(', ')}.`);
  }
  return value as KanbanColumnKey;
}

function readProvider(value: unknown): string {
  if (typeof value !== 'string' || !KANBAN_PROVIDERS.includes(value)) {
    throw invalid(`provider must be one of ${KANBAN_PROVIDERS.join(', ')}.`);
  }
  return value;
}

/** `null`, `''` or `'default'` all mean "use the app's default model". */
function readModel(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw invalid('model must be a string or null.');
  }
  const trimmed = value.trim();
  return trimmed && trimmed !== 'default' ? trimmed : null;
}

function readAttachments(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalid('attachments must be an array.');
  }
  return value.filter((entry) => entry && typeof entry === 'object');
}

function readUpdate(body: Record<string, unknown>): KanbanCardUpdateInput {
  const update: KanbanCardUpdateInput = {};
  if ('title' in body) update.title = readTitle(body.title);
  if ('description' in body) {
    if (typeof body.description !== 'string') throw invalid('description must be a string.');
    update.description = body.description;
  }
  if ('column' in body) update.column = readColumn(body.column);
  if ('position' in body) {
    if (typeof body.position !== 'number' || !Number.isFinite(body.position)) throw invalid('position must be a number.');
    update.position = body.position;
  }
  if ('provider' in body) update.provider = readProvider(body.provider);
  if ('model' in body) update.model = readModel(body.model);
  if ('attachments' in body) update.attachments = readAttachments(body.attachments);
  return update;
}

const router = express.Router();

router.get(
  '/projects/:projectId/cards',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(kanbanService.listBoard(readParam(req, 'projectId'))));
  }),
);

router.post(
  '/projects/:projectId/cards',
  asyncHandler(async (req: Request, res: Response) => {
    const body = readBody(req);
    const card = kanbanService.createCard(readParam(req, 'projectId'), {
      title: readTitle(body.title),
      description: typeof body.description === 'string' ? body.description : '',
      column: body.column === undefined ? 'backlog' : readColumn(body.column),
      provider: body.provider === undefined ? 'claude' : readProvider(body.provider),
      model: readModel(body.model),
      attachments: readAttachments(body.attachments),
    });
    res.status(201).json(createApiSuccessResponse(card));
  }),
);

/** Queues cards for the agent, one at a time: the given ids, or every card of a column (default: todo). */
router.post(
  '/projects/:projectId/queue',
  asyncHandler(async (req: Request, res: Response) => {
    const body = readBody(req);
    const cardIds = Array.isArray(body.cardIds)
      ? body.cardIds.filter((id): id is string => typeof id === 'string')
      : undefined;
    const result = await kanbanService.queueCards(readParam(req, 'projectId'), {
      cardIds,
      column: body.column === undefined ? undefined : readColumn(body.column),
    });
    res.json(createApiSuccessResponse(result));
  }),
);

/** Reads a connector payload: type, config object, optional new secret, enabled flag. */
function readConnectorInput(body: Record<string, unknown>) {
  const type = typeof body.type === 'string' && body.type.trim() ? body.type.trim() : null;
  if (!type) {
    throw invalid('type is required.');
  }
  const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config)
    ? body.config as Record<string, unknown>
    : {};
  // An empty secret means "keep the stored one": the client never receives it to send it back.
  const secret = typeof body.secret === 'string' && body.secret.trim() ? body.secret.trim() : undefined;
  return { type, config, secret, enabled: body.enabled !== false };
}

/** The tracker linked to a project (null when none); never includes the token. */
router.get(
  '/projects/:projectId/connector',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(kanbanService.getConnector(readParam(req, 'projectId'))));
  }),
);

router.put(
  '/projects/:projectId/connector',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(
      kanbanService.saveConnector(readParam(req, 'projectId'), readConnectorInput(readBody(req))),
    ));
  }),
);

router.delete(
  '/projects/:projectId/connector',
  asyncHandler(async (req: Request, res: Response) => {
    kanbanService.deleteConnector(readParam(req, 'projectId'));
    res.json(createApiSuccessResponse({ deleted: true }));
  }),
);

/** Checks settings before saving them, and lists the tracker's statuses with their default column. */
router.post(
  '/projects/:projectId/connector/test',
  asyncHandler(async (req: Request, res: Response) => {
    const { type, config, secret } = readConnectorInput(readBody(req));
    res.json(createApiSuccessResponse(await kanbanService.testConnector(readParam(req, 'projectId'), { type, config, secret })));
  }),
);

router.post(
  '/projects/:projectId/connector/sync',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(await kanbanService.syncConnector(readParam(req, 'projectId'))));
  }),
);

/** What the agent is doing on the card right now. */
router.get(
  '/cards/:cardId/activity',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(kanbanService.getActivity(readParam(req, 'cardId'))));
  }),
);

/** The card a conversation belongs to (null when it belongs to none). */
router.get(
  '/sessions/:sessionId/card',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(kanbanService.findCardBySession(readParam(req, 'sessionId'))));
  }),
);

router.get(
  '/cards/:cardId',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(kanbanService.getCard(readParam(req, 'cardId'))));
  }),
);

router.patch(
  '/cards/:cardId',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(kanbanService.updateCard(readParam(req, 'cardId'), readUpdate(readBody(req)))));
  }),
);

router.delete(
  '/cards/:cardId',
  asyncHandler(async (req: Request, res: Response) => {
    await kanbanService.deleteCard(readParam(req, 'cardId'));
    res.json(createApiSuccessResponse({ deleted: true }));
  }),
);

router.post(
  '/cards/:cardId/comments',
  asyncHandler(async (req: Request, res: Response) => {
    const body = readBody(req);
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    const attachments = readAttachments(body.attachments);
    if (!text && attachments.length === 0) {
      throw invalid('body or attachments is required.');
    }
    const card = await kanbanService.addComment(readParam(req, 'cardId'), {
      body: text,
      attachments,
      // Relaunching is the default: that is what a comment on a card is for.
      relaunch: body.relaunch !== false,
      userId: readUserId(req),
    });
    res.status(201).json(createApiSuccessResponse(card));
  }),
);

router.post(
  '/cards/:cardId/run',
  asyncHandler(async (req: Request, res: Response) => {
    const body = readBody(req);
    const card = await kanbanService.startRun(readParam(req, 'cardId'), {
      userId: readUserId(req),
      newSession: body.newSession === true,
    });
    res.json(createApiSuccessResponse(card));
  }),
);

router.post(
  '/cards/:cardId/stop',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(await kanbanService.stopRun(readParam(req, 'cardId'))));
  }),
);

export default router;
