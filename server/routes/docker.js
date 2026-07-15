import { execFile } from 'node:child_process';
import fs from 'node:fs';

import express from 'express';

const router = express.Router();

const EXEC_TIMEOUT_MS = 20_000;
const DOCKER_ACTIONS = new Set(['ps', 'up', 'down', 'stop', 'restart', 'logs']);

// Names Docker Compose auto-discovers on its own (no `-f` needed).
const CANONICAL_COMPOSE = new Set(['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']);
// Matches canonical files plus variants like `docker-compose.dev.yml`, `compose.prod.yaml`.
const COMPOSE_FILE_RE = /^(docker-)?compose(\.[\w-]+)*\.ya?ml$/i;

// Docker Compose only auto-discovers the four canonical filenames. Projects that
// name their file `docker-compose.dev.yml` (etc.) need an explicit `-f`. Return
// the base compose args (with `-f` when non-canonical) and whether a file exists.
function composeArgs(projectPath) {
  let entries = [];
  try {
    entries = fs.readdirSync(projectPath).filter((f) => COMPOSE_FILE_RE.test(f));
  } catch {
    return { hasCompose: false, base: ['compose'] };
  }
  if (entries.length === 0) return { hasCompose: false, base: ['compose'] };
  // If a canonical file is present, let Compose auto-discover (preserves the
  // implicit merge of `*.override.yml`). Otherwise pick a single variant file,
  // preferring a dev one since this panel drives local development.
  if (entries.some((f) => CANONICAL_COMPOSE.has(f.toLowerCase()))) {
    return { hasCompose: true, base: ['compose'] };
  }
  const pick = entries.find((f) => /\bdev\b|\.dev\./i.test(f)) || entries.sort()[0];
  return { hasCompose: true, base: ['compose', '-f', pick] };
}

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, ...options },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err?.code ?? 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || (err && !stderr ? err.message : '')),
        });
      },
    );
  });
}

function normalizePort(entry) {
  // `docker compose config --format json` may give a string ("3000:3000",
  // "127.0.0.1:8080:80", "5432") or an object { published, target }.
  if (entry && typeof entry === 'object') {
    const published = entry.published != null ? Number(entry.published) : null;
    const target = entry.target != null ? Number(entry.target) : null;
    return { published: Number.isInteger(published) ? published : null, target };
  }
  if (typeof entry === 'string') {
    const parts = entry.split(':');
    if (parts.length === 1) return { published: null, target: Number(parts[0]) || null };
    const published = Number(parts[parts.length - 2]);
    const target = Number(parts[parts.length - 1]);
    return {
      published: Number.isInteger(published) ? published : null,
      target: Number.isInteger(target) ? target : null,
    };
  }
  return { published: null, target: null };
}

function parseComposePs(stdout) {
  const byService = {};
  const text = stdout.trim();
  if (!text) return byService;
  let rows = [];
  try {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Newline-delimited JSON objects (docker compose v2 default).
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }
  for (const row of rows) {
    const service = row.Service || row.service;
    if (!service) continue;
    byService[service] = {
      state: row.State || row.state || 'unknown',
      publishers: Array.isArray(row.Publishers) ? row.Publishers : [],
    };
  }
  return byService;
}

// Resolve a project's compose file into services with declared/live ports and
// running state, by merging `docker compose config` with `docker compose ps`.
async function resolveComposeServices(projectPath) {
  const { hasCompose, base } = composeArgs(projectPath);
  const config = await run('docker', [...base, 'config', '--format', 'json'], { cwd: projectPath });
  if (!config.ok) {
    // A genuinely missing docker binary fails with ENOENT ("spawn docker
    // ENOENT"); anything else (bad/absent compose file, daemon down) means the
    // CLI is present but the command failed — don't report it as "not detected".
    const dockerAvailable = config.code !== 'ENOENT' && !/is not recognized/i.test(config.stderr);
    return {
      hasCompose,
      dockerAvailable,
      services: [],
      error: config.stderr.trim() || null,
    };
  }

  let parsed = {};
  try {
    parsed = JSON.parse(config.stdout);
  } catch {
    return { hasCompose: true, dockerAvailable: true, services: [], error: 'Failed to parse compose config' };
  }

  const ps = await run('docker', [...base, 'ps', '--format', 'json', '--all'], { cwd: projectPath });
  const running = ps.ok ? parseComposePs(ps.stdout) : {};

  const services = Object.entries(parsed.services || {}).map(([name, def]) => {
    const declaredPorts = (def.ports || []).map(normalizePort);
    const live = running[name];
    // Prefer actually-published ports from `ps` when the service is up.
    const livePorts = live
      ? (live.publishers || [])
          .filter((p) => p.PublishedPort)
          .map((p) => ({ published: Number(p.PublishedPort), target: Number(p.TargetPort) }))
      : [];
    const ports = livePorts.length ? livePorts : declaredPorts;
    return {
      name,
      image: def.image || null,
      state: live ? live.state : 'not created',
      ports: ports.filter((p) => p.published != null),
    };
  });

  return { hasCompose: true, dockerAvailable: true, services, error: null };
}

// GET /api/docker/services — resolve the project's compose services.
router.get('/services', async (req, res) => {
  const projectPath = req.query.projectPath;
  if (!projectPath || typeof projectPath !== 'string') {
    return res.status(400).json({ error: 'projectPath is required' });
  }
  try {
    if (!fs.statSync(projectPath).isDirectory()) {
      return res.status(400).json({ error: 'projectPath is not a directory' });
    }
  } catch {
    return res.status(400).json({ error: 'projectPath does not exist' });
  }
  res.json(await resolveComposeServices(projectPath));
});

// POST /api/docker — run a whitelisted docker compose action in the currently
// selected project's directory.
router.post('/', async (req, res) => {
  const { action, projectPath, service } = req.body || {};

  if (!DOCKER_ACTIONS.has(action)) {
    return res.status(400).json({ error: `Unsupported action: ${action}` });
  }
  if (!projectPath || typeof projectPath !== 'string') {
    return res.status(400).json({ error: 'projectPath is required' });
  }
  let stat;
  try {
    stat = fs.statSync(projectPath);
  } catch {
    return res.status(400).json({ error: 'projectPath does not exist' });
  }
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: 'projectPath is not a directory' });
  }
  if (service && !/^[a-zA-Z0-9_.-]+$/.test(service)) {
    return res.status(400).json({ error: 'Invalid service name' });
  }

  const { base } = composeArgs(projectPath);
  const argsByAction = {
    ps: [...base, 'ps'],
    up: [...base, 'up', '-d', ...(service ? [service] : [])],
    down: [...base, 'down'],
    stop: [...base, 'stop', ...(service ? [service] : [])],
    restart: [...base, 'restart', ...(service ? [service] : [])],
    logs: [...base, 'logs', '--tail', '200', '--no-color', ...(service ? [service] : [])],
  };

  const result = await run('docker', argsByAction[action], { cwd: projectPath });
  res.json(result);
});

export default router;
