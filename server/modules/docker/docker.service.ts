import { execFile } from 'node:child_process';
import fs from 'node:fs';

const EXEC_TIMEOUT_MS = 20_000;

/** Actions the panel is allowed to run — anything else is rejected up front. */
export const DOCKER_ACTIONS = ['ps', 'up', 'down', 'stop', 'restart', 'logs'] as const;
export type DockerAction = (typeof DOCKER_ACTIONS)[number];

// Names Docker Compose auto-discovers on its own (no `-f` needed).
const CANONICAL_COMPOSE = new Set(['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']);
// Matches canonical files plus variants like `docker-compose.dev.yml`, `compose.prod.yaml`.
const COMPOSE_FILE_RE = /^(docker-)?compose(\.[\w-]+)*\.ya?ml$/i;

export type CommandResult = {
  ok: boolean;
  code: string | number;
  stdout: string;
  stderr: string;
};

type ComposeService = {
  name: string;
  image: string | null;
  state: string;
  ports: { published: number | null; target: number | null }[];
};

export type ComposeServicesResult = {
  hasCompose: boolean;
  dockerAvailable: boolean;
  services: ComposeService[];
  error: string | null;
};

// Docker Compose only auto-discovers the four canonical filenames. Projects that
// name their file `docker-compose.dev.yml` (etc.) need an explicit `-f`. Return
// the base compose args (with `-f` when non-canonical) and whether a file exists.
function composeArgs(projectPath: string): { hasCompose: boolean; base: string[] } {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(projectPath).filter((file) => COMPOSE_FILE_RE.test(file));
  } catch {
    return { hasCompose: false, base: ['compose'] };
  }
  if (entries.length === 0) return { hasCompose: false, base: ['compose'] };
  // If a canonical file is present, let Compose auto-discover (preserves the
  // implicit merge of `*.override.yml`). Otherwise pick a single variant file,
  // preferring a dev one since this panel drives local development.
  if (entries.some((file) => CANONICAL_COMPOSE.has(file.toLowerCase()))) {
    return { hasCompose: true, base: ['compose'] };
  }
  const pick = entries.find((file) => /\bdev\b|\.dev\./i.test(file)) || entries.sort()[0];
  return { hasCompose: true, base: ['compose', '-f', pick] };
}

export function run(
  cmd: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, ...options },
      (err, stdout, stderr) => {
        const execError = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
        resolve({
          ok: !err,
          code: execError?.code ?? 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || (err && !stderr ? err.message : '')),
        });
      },
    );
  });
}

function normalizePort(entry: unknown): { published: number | null; target: number | null } {
  // `docker compose config --format json` may give a string ("3000:3000",
  // "127.0.0.1:8080:80", "5432") or an object { published, target }.
  if (entry && typeof entry === 'object') {
    const record = entry as { published?: unknown; target?: unknown };
    const published = record.published != null ? Number(record.published) : null;
    const target = record.target != null ? Number(record.target) : null;
    return {
      published: Number.isInteger(published) ? published : null,
      target: Number.isInteger(target) ? target : null,
    };
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

type PsRow = {
  Service?: string;
  service?: string;
  State?: string;
  state?: string;
  Publishers?: { PublishedPort?: number; TargetPort?: number }[];
};

function parseComposePs(stdout: string): Record<string, { state: string; publishers: NonNullable<PsRow['Publishers']> }> {
  const byService: Record<string, { state: string; publishers: NonNullable<PsRow['Publishers']> }> = {};
  const text = stdout.trim();
  if (!text) return byService;

  let rows: PsRow[] = [];
  try {
    const parsed = JSON.parse(text) as PsRow | PsRow[];
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Newline-delimited JSON objects (docker compose v2 default).
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as PsRow);
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

/**
 * Resolves a project's compose file into services with declared/live ports and
 * running state, by merging `docker compose config` with `docker compose ps`.
 */
export async function resolveComposeServices(projectPath: string): Promise<ComposeServicesResult> {
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

  let parsed: { services?: Record<string, { image?: string; ports?: unknown[] }> } = {};
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
      ? live.publishers
          .filter((publisher) => publisher.PublishedPort)
          .map((publisher) => ({
            published: Number(publisher.PublishedPort),
            target: Number(publisher.TargetPort),
          }))
      : [];
    const ports = livePorts.length ? livePorts : declaredPorts;
    return {
      name,
      image: def.image || null,
      state: live ? live.state : 'not created',
      ports: ports.filter((port) => port.published != null),
    };
  });

  return { hasCompose: true, dockerAvailable: true, services, error: null };
}

/** Builds the argv for a whitelisted action against the project's compose file. */
export function composeActionArgs(
  projectPath: string,
  action: DockerAction,
  service: string | null,
): string[] {
  const { base } = composeArgs(projectPath);
  const serviceArgs = service ? [service] : [];
  const argsByAction: Record<DockerAction, string[]> = {
    ps: [...base, 'ps'],
    up: [...base, 'up', '-d', ...serviceArgs],
    down: [...base, 'down'],
    stop: [...base, 'stop', ...serviceArgs],
    restart: [...base, 'restart', ...serviceArgs],
    logs: [...base, 'logs', '--tail', '200', '--no-color', ...serviceArgs],
  };
  return argsByAction[action];
}
