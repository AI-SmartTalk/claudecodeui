// voiceRoutes: used by the server entrypoint to mount authenticated STT/TTS endpoints.
export { voiceRoutes } from './voice.module.js';
// localWhisperRoutes: mounted under /api/voice/local-whisper to run the bundled Whisper container.
export { localWhisperRoutes } from './local-whisper.routes.js';
