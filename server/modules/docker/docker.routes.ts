import fs from 'node:fs';

import express from 'express';

import { asyncHandler } from '@/shared/utils.js';

import {
  DOCKER_ACTIONS,
  composeActionArgs,
  resolveComposeServices,
  run,
  type DockerAction,
} from './docker.service.js';

const ALLOWED_ACTIONS = new Set<string>(DOCKER_ACTIONS);

/**
 * Validates the caller-supplied project directory.
 *
 * Returns the error message to send back, or null when the path is usable.
 */
function validateProjectPath(projectPath: unknown): string | null {
  if (!projectPath || typeof projectPath !== 'string') {
    return 'projectPath is required';
  }
  try {
    if (!fs.statSync(projectPath).isDirectory()) {
      return 'projectPath is not a directory';
    }
  } catch {
    return 'projectPath does not exist';
  }
  return null;
}

const router = express.Router();

// GET /api/docker/services — resolve the project's compose services.
router.get('/services', asyncHandler(async (req, res) => {
  const projectPath = req.query.projectPath;
  const error = validateProjectPath(projectPath);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  res.json(await resolveComposeServices(projectPath as string));
}));

// POST /api/docker — run a whitelisted docker compose action in the currently
// selected project's directory.
router.post('/', asyncHandler(async (req, res) => {
  const { action, projectPath, service } = (req.body || {}) as {
    action?: string;
    projectPath?: string;
    service?: string;
  };

  if (!action || !ALLOWED_ACTIONS.has(action)) {
    res.status(400).json({ error: `Unsupported action: ${action}` });
    return;
  }

  const error = validateProjectPath(projectPath);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  if (service && !/^[a-zA-Z0-9_.-]+$/.test(service)) {
    res.status(400).json({ error: 'Invalid service name' });
    return;
  }

  const args = composeActionArgs(projectPath as string, action as DockerAction, service || null);
  res.json(await run('docker', args, { cwd: projectPath as string }));
}));

export const dockerRoutes = router;
