import { useEffect, useState, type InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { useUiPreferences, useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import { useVoiceConfig } from '@/modules/settings/hooks/useVoiceConfig';
import { Mic, Loader2, CheckCircle2 } from 'lucide-react';
import { api } from '@/shared/api';
import { Button } from '@/shared/ui/Button';

const inputClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

function Field({ label, ...props }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <input className={inputClass} {...props} />
    </label>
  );
}

/** Rendered by Settings for the "voice" tab, covering speech-to-text provider credentials. */
type WhisperStatus = {
  dockerAvailable: boolean;
  running: boolean;
  configured: boolean;
  port: number;
  model: string;
  baseUrl: string;
};

// One-click local speech-to-text: starts a Docker Whisper container and points
// the voice proxy at it. STT runs fully on your machine, reachable from mobile.
function LocalWhisperSection({ onConfigured }: { onConfigured: (model: string) => void }) {
  // Tracks the local container status shown in settings.
  const [status, setStatus] = useState<WhisperStatus | null>(null);
  // Disables actions while the container is being changed.
  const [busy, setBusy] = useState<'enable' | 'disable' | null>(null);
  // Shows setup progress and failures.
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api.voice.localWhisper.status();
      setStatus(await res.json());
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const enable = async () => {
    setBusy('enable');
    setMessage('Starting… the first run downloads the image and model — this can take a few minutes.');
    try {
      const res = await api.voice.localWhisper.enable();
      const data = await res.json();
      if (data.ok) {
        onConfigured(data.model);
        setMessage(data.note || 'Local Whisper enabled — voice input now uses it.');
      } else {
        setMessage(data.error || 'Failed to enable local Whisper.');
      }
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(null);
      void load();
    }
  };

  const disable = async () => {
    setBusy('disable');
    setMessage(null);
    try {
      await api.voice.localWhisper.disable();
      setMessage('Local Whisper stopped.');
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(null);
      void load();
    }
  };

  const active = status?.running && status?.configured;

  return (
    <SettingsSection
      title="Local Whisper (Docker)"
      description="Run speech-to-text locally in a container — no API key, works offline and from your phone."
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
          <Mic className="h-5 w-5 text-muted-foreground" />
          <div className="mr-auto text-sm">
            {status && !status.dockerAvailable ? (
              <span className="text-amber-600 dark:text-amber-400">Docker not detected on this machine.</span>
            ) : active ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" /> Running on port {status?.port} · model {status?.model}
              </span>
            ) : (
              <span className="text-muted-foreground">
                Not running. One click starts Whisper and switches voice input to it.
              </span>
            )}
          </div>
          {active ? (
            <Button size="sm" variant="secondary" onClick={disable} disabled={!!busy}>
              {busy === 'disable' ? <Loader2 className="animate-spin" /> : null} Disable
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={enable}
              disabled={!!busy || (status ? !status.dockerAvailable : false)}
            >
              {busy === 'enable' ? <Loader2 className="animate-spin" /> : null} Enable local Whisper
            </Button>
          )}
        </div>
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
      </div>
    </SettingsSection>
  );
}

export default function VoiceSettingsTab() {
  const { t } = useTranslation('settings');
  const preferences = useUiPreferences();
  const setPreference = useSetUiPreference();
  const { config, update } = useVoiceConfig();
  const voiceEnabled = preferences.voiceEnabled;

  return (
    <div className="space-y-8">
      <SettingsSection title={t('voiceSettings.title')} description={t('voiceSettings.description')}>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="pr-3">
            <div className="text-sm font-medium text-foreground">{t('voiceSettings.enable')}</div>
            <div className="text-xs text-muted-foreground">{t('voiceSettings.enableDescription')}</div>
          </div>
          <SettingsToggle
            checked={voiceEnabled}
            onChange={(v) => setPreference('voiceEnabled', v)}
            ariaLabel={t('voiceSettings.enable')}
          />
        </div>
      </SettingsSection>

      {voiceEnabled && (
        <LocalWhisperSection
          onConfigured={(model) => {
            // Route through the server proxy (empty client baseUrl) and match the
            // model header; dispatches the sync event so voice availability updates.
            update({ baseUrl: '', sttModel: model });
          }}
        />
      )}

      {voiceEnabled && (
        <SettingsSection title={t('voiceSettings.backendTitle')} description={t('voiceSettings.backendDescription')}>
          <div className="space-y-4">
            <Field
              label={t('voiceSettings.baseUrl')}
              placeholder="https://api.openai.com/v1"
              value={config.baseUrl}
              onChange={(e) => update({ baseUrl: e.target.value })}
            />
            <Field
              label={t('voiceSettings.apiKey')}
              type="password"
              autoComplete="off"
              placeholder="sk-…"
              value={config.apiKey}
              onChange={(e) => update({ apiKey: e.target.value })}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <Field
                label={t('voiceSettings.sttModel')}
                placeholder="whisper-1"
                value={config.sttModel}
                onChange={(e) => update({ sttModel: e.target.value })}
              />
              <Field
                label={t('voiceSettings.ttsModel')}
                placeholder="tts-1"
                value={config.ttsModel}
                onChange={(e) => update({ ttsModel: e.target.value })}
              />
              <Field
                label={t('voiceSettings.voice')}
                placeholder="alloy"
                value={config.ttsVoice}
                onChange={(e) => update({ ttsVoice: e.target.value })}
              />
              <Field
                label={t('voiceSettings.format')}
                placeholder="mp3"
                value={config.ttsFormat}
                onChange={(e) => update({ ttsFormat: e.target.value })}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t('voiceSettings.note')}</p>
          </div>
        </SettingsSection>
      )}
    </div>
  );
}
