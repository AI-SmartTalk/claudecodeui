import multer from 'multer';

import { appConfigDb } from '@/modules/database/index.js';

import { VOICE_BASE_URL_KEY, VOICE_STT_MODEL_KEY } from './local-whisper.routes.js';
import { createVoiceRouter } from './voice.routes.js';
import { createVoiceService } from './voice.service.js';

const DEFAULT_VOICE_TIMEOUT_MS = 300_000;
const parsedTimeoutMs = Number(process.env.VOICE_TIMEOUT_MS);
const voiceTimeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
  ? parsedTimeoutMs
  : DEFAULT_VOICE_TIMEOUT_MS;

const ENV_BASE_URL = (process.env.VOICE_API_BASE_URL || '').replace(/\/$/, '');
const ENV_STT_MODEL = process.env.VOICE_STT_MODEL || 'whisper-1';

function storedValue(key: string): string {
  return (appConfigDb.get(key) || '').replace(/\/$/, '');
}

/**
 * Server-side defaults, read through getters so a backend enabled at runtime
 * (the local Whisper container from Settings, see local-whisper.routes.ts) takes
 * effect without a restart. Still server-controlled: the browser never picks the
 * outbound host, so this stays free of SSRF input.
 */
const voiceDefaults = {
  get baseUrl(): string {
    return storedValue(VOICE_BASE_URL_KEY) || ENV_BASE_URL;
  },
  get apiKey(): string {
    return process.env.VOICE_API_KEY || '';
  },
  get sttModel(): string {
    return storedValue(VOICE_STT_MODEL_KEY) || ENV_STT_MODEL;
  },
  get ttsModel(): string {
    return process.env.VOICE_TTS_MODEL || 'tts-1';
  },
  get ttsVoice(): string {
    return process.env.VOICE_TTS_VOICE || 'alloy';
  },
};

const voiceService = createVoiceService({
  defaults: voiceDefaults,
  timeoutMs: voiceTimeoutMs,
  fetchBackend: async (url, options) => {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), voiceTimeoutMs);
    try {
      return await fetch(url, {
        redirect: 'manual',
        ...options,
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  },
});

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** Voice router assembled for the server entrypoint. */
export const voiceRoutes = createVoiceRouter({
  voiceService,
  parseAudioUpload: audioUpload.single('audio'),
});
