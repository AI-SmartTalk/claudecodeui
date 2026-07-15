// Local Whisper (Docker) management for CloudCLI voice mode.
//
// Starts/stops the OpenAI-compatible faster-whisper-server container defined in
// docker/whisper/docker-compose.yml and persists its base URL server-side so the
// /api/voice proxy forwards speech-to-text to it. Persisting the URL in the DB
// (not per-request client headers) keeps the anti-SSRF guarantee: the browser
// never chooses the outbound host.
import { execFile } from 'node:child_process';
import path from 'node:path';

import express from 'express';

import { appConfigDb } from '../modules/database/index.js';
import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

const APP_ROOT = findAppRoot(getModuleDir(import.meta.url));
const COMPOSE_FILE = path.join(APP_ROOT, 'docker', 'whisper', 'docker-compose.yml');

const WHISPER_PORT = process.env.WHISPER_PORT || '8071';
const STT_MODEL = 'Systran/faster-whisper-small';
const BASE_URL = `http://localhost:${WHISPER_PORT}/v1`;

// Config keys read by voice-proxy.js resolveConfig().
export const VOICE_BASE_URL_KEY = 'voice_base_url';
export const VOICE_STT_MODEL_KEY = 'voice_stt_model';

const router = express.Router();

function run(args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['compose', '-f', COMPOSE_FILE, ...args],
      { cwd: APP_ROOT, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || (err && !err.killed ? err.message : '')),
          timedOut: Boolean(err && err.killed),
        });
      },
    );
  });
}

async function isRunning() {
  const ps = await run(['ps', '--format', 'json', '--status', 'running']);
  return ps.ok && ps.stdout.trim().length > 0 && /whisper/i.test(ps.stdout);
}

function isConfigured() {
  return (appConfigDb.get(VOICE_BASE_URL_KEY) || '') === BASE_URL;
}

async function waitForHealthy(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${WHISPER_PORT}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return false;
}

// GET /api/voice/local-whisper/status
router.get('/status', async (_req, res) => {
  const version = await run(['version'], 8000);
  const dockerAvailable = version.ok || !/not found|command not found|not recognized/i.test(version.stderr);
  res.json({
    dockerAvailable,
    running: dockerAvailable ? await isRunning() : false,
    configured: isConfigured(),
    port: Number(WHISPER_PORT),
    model: STT_MODEL,
    baseUrl: BASE_URL,
  });
});

// POST /api/voice/local-whisper/enable — pull/start the container (first run
// downloads the image + model, so allow several minutes), wait until healthy,
// then persist the base URL + STT model for the voice proxy.
router.post('/enable', async (_req, res) => {
  const up = await run(['up', '-d'], 15 * 60_000);
  if (!up.ok) {
    return res.status(502).json({
      error: up.timedOut ? 'Timed out starting the Whisper container.' : 'Failed to start Whisper.',
      details: up.stderr.trim() || null,
    });
  }

  const healthy = await waitForHealthy();

  appConfigDb.set(VOICE_BASE_URL_KEY, BASE_URL);
  appConfigDb.set(VOICE_STT_MODEL_KEY, STT_MODEL);

  res.json({
    ok: true,
    running: true,
    configured: true,
    healthy,
    port: Number(WHISPER_PORT),
    model: STT_MODEL,
    baseUrl: BASE_URL,
    note: healthy
      ? null
      : 'Container started but not healthy yet — the model may still be downloading. It will work shortly.',
  });
});

// POST /api/voice/local-whisper/disable — stop the container and clear the
// persisted voice backend so the proxy falls back to env defaults.
router.post('/disable', async (_req, res) => {
  const down = await run(['down'], 60_000);
  if (isConfigured()) {
    appConfigDb.set(VOICE_BASE_URL_KEY, '');
    appConfigDb.set(VOICE_STT_MODEL_KEY, '');
  }
  res.json({ ok: down.ok, running: false, configured: false, details: down.ok ? null : down.stderr.trim() });
});

export default router;
