import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Paperclip, Sparkles, X } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { ChatAttachment } from '@/shared/types';
import KanbanModelSelect from '@/modules/kanban/KanbanModelSelect';

/** Requests the dialog offers as a starting point. */
const EXAMPLES = [
  'Il faut un export CSV des commandes depuis le back-office.',
  'Découpe la refonte de la page de connexion (mode sombre, mot de passe oublié).',
  'Passe en revue le module paiement et crée les cartes de dette technique.',
];

type KanbanPlanDialogProps = {
  projectId: string;
  onClose: () => void;
  /** Called with the planning conversation once the agent has started. */
  onStarted: (sessionId: string) => void;
};

/**
 * Rendered by KanbanPanel: the "prepare with the agent" request. The agent
 * reads the project, then creates the cards in the backlog through the kanban
 * MCP tools, so they appear on the board as it works.
 */
export default function KanbanPlanDialog({ projectId, onClose, onStarted }: KanbanPlanDialogProps) {
  const { t } = useTranslation();
  // The request the agent turns into cards.
  const [prompt, setPrompt] = useState('');
  // Model the planning agent runs on; null = Settings default.
  const [model, setModel] = useState<string | null>(null);
  // Files (specs, mockups) handed to the agent with the request.
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  // The action in flight and its failure.
  const [busy, setBusy] = useState<'upload' | 'start' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    setBusy('upload');
    setError(null);
    try {
      const formData = new FormData();
      files.forEach((file) => formData.append('files', file));
      const response = await api.assets.uploadFiles(formData);
      const body = await response.json().catch(() => null) as { attachments?: ChatAttachment[]; error?: string } | null;
      if (!response.ok || !Array.isArray(body?.attachments)) throw new Error(body?.error || 'Upload failed');
      setAttachments((current) => [...current, ...(body?.attachments ?? [])]);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setBusy(null);
    }
  };

  const handleStart = async () => {
    if (!prompt.trim()) return;
    setBusy('start');
    setError(null);
    try {
      const body = await readApiJson<{ data: { sessionId: string } }>(
        await api.kanban.plan(projectId, { prompt: prompt.trim(), model, attachments }),
      );
      onStarted(body.data.sessionId);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[92dvh] w-[calc(100vw-1rem)] max-w-xl flex-col overflow-hidden p-0">
        <DialogTitle>{t('kanban.plan.title', { defaultValue: 'Prepare cards with the agent' })}</DialogTitle>
        <div className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{t('kanban.plan.title', { defaultValue: 'Prepare cards with the agent' })}</div>
            <div className="text-xs text-muted-foreground">
              {t('kanban.plan.subtitle', { defaultValue: 'It reads the project, splits the work and creates the cards in the backlog. It changes no file.' })}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <textarea
            autoFocus
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void handleStart();
              }
            }}
            rows={7}
            placeholder={t('kanban.plan.placeholder', { defaultValue: 'What should be done? A feature, a bug, a spec to split, a review…' })}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground"
          />
          {!prompt && (
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setPrompt(example)}
                  className="rounded-full border border-border px-2.5 py-1 text-left text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
                >
                  {example}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {attachments.map((attachment, index) => (
              <span key={`${attachment.path}-${index}`} className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs">
                <Paperclip className="h-3 w-3" />
                <span className="max-w-40 truncate">{attachment.name}</span>
                <button type="button" onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))} aria-label="Remove">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => void handleFiles(event)} />
            <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={busy !== null}>
              {busy === 'upload' ? <Loader2 className="animate-spin" /> : <Paperclip />}
              {t('kanban.plan.attach', { defaultValue: 'Spec, mockup…' })}
            </Button>
          </div>

          <label className="block space-y-1 text-xs text-muted-foreground">
            <span>{t('kanban.fields.model', { defaultValue: 'Model' })}</span>
            <KanbanModelSelect
              provider="claude"
              value={model}
              onChange={setModel}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
          </label>

          {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('kanban.plan.cancel', { defaultValue: 'Cancel' })}</Button>
          <Button type="button" size="sm" onClick={() => void handleStart()} disabled={!prompt.trim() || busy !== null}>
            {busy === 'start' ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {t('kanban.plan.start', { defaultValue: 'Prepare the cards' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
