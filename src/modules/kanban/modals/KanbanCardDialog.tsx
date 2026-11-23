import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  Bot,
  ExternalLink,
  FlaskConical,
  Loader2,
  MessageSquare,
  Paperclip,
  Play,
  Plus,
  RotateCcw,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { KANBAN_COLUMN_LABELS, KANBAN_COLUMN_ORDER } from '@/shared/constants';
import type {
  ChatAttachment,
  KanbanCardDetails,
  KanbanColumnKey,
  KanbanComment,
  LLMProvider,
} from '@/shared/types';
import { formatRelativeTime } from '@/shared/utils';
import KanbanAgentActivity from '@/modules/kanban/KanbanAgentActivity';
import { useKanbanModels } from '@/modules/kanban/hooks/useKanbanModels';

/** Refresh rate of an open card, so the agent's reply shows up without reopening it. */
const CARD_POLL_INTERVAL_MS = 3000;

const PROVIDER_LABELS: Record<LLMProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};

const fieldClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground';

type KanbanCardDialogProps = {
  projectId: string;
  /** The card to show; null opens the dialog in "new card" mode. */
  cardId: string | null;
  /** Column a new card is created in. */
  initialColumn: KanbanColumnKey;
  onClose: () => void;
  /** Called after any change, so the board re-reads itself. */
  onChanged: () => void;
  onOpenSession: (sessionId: string) => void;
};

async function uploadAttachments(files: File[]): Promise<ChatAttachment[]> {
  if (files.length === 0) {
    return [];
  }
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));
  const response = await api.assets.uploadFiles(formData);
  const body = await response.json().catch(() => null) as { attachments?: ChatAttachment[]; error?: string } | null;
  if (!response.ok || !Array.isArray(body?.attachments)) {
    throw new Error(body?.error || 'Upload failed');
  }
  return body.attachments;
}

function isImageAttachment(attachment: ChatAttachment): boolean {
  return Boolean(attachment.mimeType?.startsWith('image/'))
    || /\.(gif|jpe?g|png|webp|svg)$/i.test(attachment.path || attachment.name || '');
}

function basename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

/** An attachment chip; images load through the authenticated assets endpoint and open full size on click. */
function AttachmentPreview({ attachment, onRemove }: { attachment: ChatAttachment; onRemove?: () => void }) {
  // Object URL of the fetched image; the endpoint needs the auth header, so a bare <img src> cannot be used.
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const isImage = isImageAttachment(attachment);

  useEffect(() => {
    if (!isImage || !attachment.path) {
      return undefined;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    void api.assets.image(basename(attachment.path)).then(async (response) => {
      if (!response.ok || cancelled) {
        return;
      }
      objectUrl = URL.createObjectURL(await response.blob());
      if (cancelled) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      setImageUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [attachment.path, isImage]);

  const label = attachment.name || basename(attachment.path ?? '');
  return (
    <div className="group relative flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 p-1 text-xs">
      {imageUrl ? (
        <a href={imageUrl} target="_blank" rel="noreferrer">
          <img src={imageUrl} alt={label} className="h-16 w-16 rounded object-cover" />
        </a>
      ) : (
        <span className="flex items-center gap-1 px-1 py-0.5"><Paperclip className="h-3 w-3" />{label}</span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 rounded-full bg-background p-0.5 shadow ring-1 ring-border"
          aria-label="Remove"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** Markdown with the app's typography, for descriptions, replies and comments. */
function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none break-words dark:prose-invert prose-p:my-1.5 prose-pre:my-2 [&_pre]:overflow-x-auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function CommentEntry({ comment }: { comment: KanbanComment }) {
  const { t, i18n } = useTranslation();
  if (comment.author === 'system') {
    return (
      <div className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1">{comment.body}</span>
        <span className="shrink-0">{formatRelativeTime(comment.createdAt, i18n.language)}</span>
      </div>
    );
  }
  const isAgent = comment.author === 'agent';
  return (
    <div className={`flex gap-2 ${isAgent ? '' : 'flex-row-reverse'}`}>
      <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${isAgent ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>
        {isAgent ? <Bot className="h-3.5 w-3.5" /> : t('kanban.comment.youShort', { defaultValue: 'Me' })}
      </div>
      <div className={`min-w-0 max-w-[85%] rounded-lg px-3 py-2 text-sm ${isAgent ? 'border border-border/60 bg-background' : 'bg-primary/10'}`}>
        <div className="mb-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-medium">
            {isAgent ? t('kanban.comment.agent', { defaultValue: 'Agent' }) : t('kanban.comment.you', { defaultValue: 'You' })}
          </span>
          <span>{formatRelativeTime(comment.createdAt, i18n.language)}</span>
          {!isAgent && !comment.delivered && (
            <span className="rounded bg-amber-500/15 px-1 text-amber-600 dark:text-amber-400">
              {t('kanban.comment.pending', { defaultValue: 'waiting for the agent' })}
            </span>
          )}
        </div>
        {comment.body && <Markdown text={comment.body} />}
        {comment.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {comment.attachments.map((attachment, index) => (
              <AttachmentPreview key={`${attachment.path}-${index}`} attachment={attachment} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The model menu of a card: "Default (…)" plus the provider's catalog. */
function ModelSelect({ provider, value, onChange }: {
  provider: LLMProvider;
  value: string | null;
  onChange: (model: string | null) => void;
}) {
  const { t } = useTranslation();
  const { options, defaultLabel } = useKanbanModels(provider);
  return (
    <select value={value ?? ''} onChange={(event) => onChange(event.target.value || null)} className={fieldClass}>
      <option value="">
        {defaultLabel && !/^default/i.test(defaultLabel)
          ? `${t('kanban.model.default', { defaultValue: 'Default' })} · ${defaultLabel}`
          : t('kanban.model.default', { defaultValue: 'Default' })}
      </option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
      {value && !options.some((option) => option.value === value) && <option value={value}>{value}</option>}
    </select>
  );
}

/**
 * Rendered by KanbanPanel: creates a card, or shows one in two panels — the
 * card itself (fields, attachments, conversations) and the agent side (live
 * activity or "what to test", controls, comment thread). A comment relaunches
 * the agent on the card's conversation unless the box is unticked.
 */
export default function KanbanCardDialog({
  projectId,
  cardId,
  initialColumn,
  onClose,
  onChanged,
  onOpenSession,
}: KanbanCardDialogProps) {
  const { t } = useTranslation();
  // The card as last read; null in "new card" mode and until the first read.
  const [card, setCard] = useState<KanbanCardDetails | null>(null);
  // The editable fields, separate from `card` so a poll does not overwrite what the user is typing.
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [column, setColumn] = useState<KanbanColumnKey>(initialColumn);
  const [provider, setProvider] = useState<LLMProvider>('claude');
  const [model, setModel] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  // True once the user edited a field, so the form is only seeded from the server once.
  const [isDirty, setIsDirty] = useState(false);
  // Whether the description is shown rendered (imported tickets) or as an editable field.
  const [isEditingDescription, setIsEditingDescription] = useState(cardId === null);
  // The comment being written and its attachments.
  const [commentText, setCommentText] = useState('');
  const [commentAttachments, setCommentAttachments] = useState<ChatAttachment[]>([]);
  // Whether posting the comment should relaunch the agent (the point of commenting, so on by default).
  const [relaunchOnComment, setRelaunchOnComment] = useState(true);
  // The action in flight, to disable buttons and show a spinner on the right one.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  // The last action failure, shown at the top of the dialog.
  const [error, setError] = useState<string | null>(null);
  const cardFileInputRef = useRef<HTMLInputElement>(null);
  const commentFileInputRef = useRef<HTMLInputElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  // Read by the poll, which must not reseed fields the user is editing.
  const isDirtyRef = useRef(false);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  const loadCard = useCallback(async () => {
    if (!cardId) {
      return;
    }
    try {
      const body = await readApiJson<{ data: KanbanCardDetails }>(await api.kanban.card(cardId));
      setCard(body.data);
      if (!isDirtyRef.current) {
        setTitle(body.data.title);
        setDescription(body.data.description);
        setColumn(body.data.column);
        setProvider(body.data.provider);
        setModel(body.data.model);
        setAttachments(body.data.attachments);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [cardId]);

  useEffect(() => {
    void loadCard();
    if (!cardId) {
      return undefined;
    }
    const timer = window.setInterval(() => void loadCard(), CARD_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [cardId, loadCard]);

  const commentCount = card?.comments.length ?? 0;
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' });
  }, [commentCount]);

  const runAction = useCallback(async (name: string, action: () => Promise<void>) => {
    setBusyAction(name);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusyAction(null);
    }
  }, [onChanged]);

  const markDirty = () => setIsDirty(true);

  const handleCardFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void runAction('upload', async () => {
      const uploaded = await uploadAttachments(files);
      setAttachments((current) => [...current, ...uploaded]);
      markDirty();
    });
  };

  const handleCommentFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void runAction('upload', async () => {
      const uploaded = await uploadAttachments(files);
      setCommentAttachments((current) => [...current, ...uploaded]);
    });
  };

  const fields = () => ({ title: title.trim(), description, column, provider, model, attachments });

  const requireTitle = () => {
    if (!title.trim()) {
      throw new Error(t('kanban.errors.titleRequired', { defaultValue: 'A title is required.' }));
    }
  };

  const handleCreate = (launch: boolean) => runAction(launch ? 'create-run' : 'create', async () => {
    requireTitle();
    const created = await readApiJson<{ data: { id: string } }>(await api.kanban.createCard(projectId, {
      ...fields(),
      column: launch && column === 'backlog' ? 'todo' : column,
    }));
    if (launch) {
      await readApiJson(await api.kanban.run(created.data.id));
    }
    onClose();
  });

  const saveIfDirty = async () => {
    if (cardId && isDirty) {
      requireTitle();
      await readApiJson(await api.kanban.updateCard(cardId, fields()));
      setIsDirty(false);
    }
  };

  const handleSave = () => runAction('save', async () => {
    await saveIfDirty();
    await loadCard();
  });

  const handleRun = (newSession: boolean) => runAction(newSession ? 'run-new' : 'run', async () => {
    if (!cardId) return;
    await saveIfDirty();
    await readApiJson(await api.kanban.run(cardId, { newSession }));
    await loadCard();
  });

  const handleStop = () => runAction('stop', async () => {
    if (!cardId) return;
    await readApiJson(await api.kanban.stop(cardId));
    await loadCard();
  });

  const handleDelete = () => runAction('delete', async () => {
    if (!cardId) return;
    if (!window.confirm(t('kanban.confirmDelete', { defaultValue: 'Delete this card and its comments? Its conversations are kept.' }))) {
      return;
    }
    await readApiJson(await api.kanban.deleteCard(cardId));
    onClose();
  });

  const handleMarkDone = () => runAction('done', async () => {
    if (!cardId) return;
    await saveIfDirty();
    await readApiJson(await api.kanban.updateCard(cardId, { column: 'done' }));
    setColumn('done');
    await loadCard();
  });

  const handleComment = () => runAction('comment', async () => {
    if (!cardId || (!commentText.trim() && commentAttachments.length === 0)) return;
    await saveIfDirty();
    await readApiJson(await api.kanban.addComment(cardId, {
      body: commentText.trim(),
      attachments: commentAttachments,
      relaunch: relaunchOnComment,
    }));
    setCommentText('');
    setCommentAttachments([]);
    await loadCard();
  });

  const isRunning = card?.agentStatus === 'running';
  const isQueued = card?.agentStatus === 'queued';
  const isNew = cardId === null;
  const columnLabel = (key: KanbanColumnKey) => t(`kanban.columns.${key}`, { defaultValue: KANBAN_COLUMN_LABELS[key] });
  const isBusy = busyAction !== null;

  const cardPanel = (
    <div className="space-y-5">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>{t('kanban.fields.column', { defaultValue: 'Column' })}</span>
          <select value={column} onChange={(event) => { setColumn(event.target.value as KanbanColumnKey); markDirty(); }} className={fieldClass}>
            {KANBAN_COLUMN_ORDER.map((key) => <option key={key} value={key}>{columnLabel(key)}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>{t('kanban.fields.provider', { defaultValue: 'Agent' })}</span>
          <select
            value={provider}
            onChange={(event) => { setProvider(event.target.value as LLMProvider); setModel(null); markDirty(); }}
            disabled={isRunning}
            className={fieldClass}
          >
            {(Object.keys(PROVIDER_LABELS) as LLMProvider[]).map((key) => <option key={key} value={key}>{PROVIDER_LABELS[key]}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>{t('kanban.fields.model', { defaultValue: 'Model' })}</span>
          <ModelSelect provider={provider} value={model} onChange={(next) => { setModel(next); markDirty(); }} />
        </label>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('kanban.fields.description', { defaultValue: 'Description' })}</span>
          {!isNew && description && (
            <button type="button" className="text-primary hover:underline" onClick={() => setIsEditingDescription((value) => !value)}>
              {isEditingDescription ? t('kanban.preview', { defaultValue: 'Preview' }) : t('kanban.edit', { defaultValue: 'Edit' })}
            </button>
          )}
        </div>
        {isEditingDescription || !description ? (
          <textarea
            value={description}
            onChange={(event) => { setDescription(event.target.value); markDirty(); }}
            rows={isNew ? 9 : 7}
            placeholder={t('kanban.descriptionPlaceholder', { defaultValue: 'Context, acceptance criteria, how to test… (markdown)' })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
          />
        ) : (
          <div className="max-h-80 overflow-y-auto rounded-md border border-border/50 bg-muted/20 px-3 py-2">
            <Markdown text={description} />
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-xs text-muted-foreground">{t('kanban.attachments', { defaultValue: 'Attachments' })}</div>
        <div className="flex flex-wrap items-center gap-2">
          {attachments.map((attachment, index) => (
            <AttachmentPreview
              key={`${attachment.path}-${index}`}
              attachment={attachment}
              onRemove={() => { setAttachments((current) => current.filter((_, i) => i !== index)); markDirty(); }}
            />
          ))}
          <input ref={cardFileInputRef} type="file" multiple className="hidden" onChange={handleCardFiles} />
          <Button type="button" variant="outline" size="sm" onClick={() => cardFileInputRef.current?.click()} disabled={isBusy}>
            {busyAction === 'upload' ? <Loader2 className="animate-spin" /> : <Paperclip />} {t('kanban.attach', { defaultValue: 'Attach' })}
          </Button>
        </div>
      </div>

      {!isNew && card && (
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">{t('kanban.conversations', { defaultValue: 'Conversations' })}</div>
          {card.sessions.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
              {t('kanban.noConversation', { defaultValue: 'No conversation yet. Launch the agent to start one.' })}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {[...card.sessions].reverse().map((session) => (
                <button
                  key={session.sessionId}
                  type="button"
                  disabled={!session.exists}
                  onClick={() => onOpenSession(session.sessionId)}
                  className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                >
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {session.title || session.sessionId}
                    {!session.exists && ` — ${t('kanban.deleted', { defaultValue: 'deleted' })}`}
                  </span>
                  {session.sessionId === card.activeSessionId && (
                    <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">{t('kanban.active', { defaultValue: 'active' })}</span>
                  )}
                  <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const agentPanel = card && (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="space-y-3">
        {card.agentStatus === 'failed' && card.agentError && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>{t('kanban.lastRunFailed', { defaultValue: 'Last run failed:' })} {card.agentError}</span>
          </div>
        )}

        {isRunning ? (
          <KanbanAgentActivity cardId={card.id} onOpenSession={onOpenSession} />
        ) : card.latestAgentReply && (card.column === 'review' || card.column === 'done') ? (
          <div className="rounded-lg border border-violet-500/25 bg-violet-500/5 p-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
              <FlaskConical className="h-3.5 w-3.5" /> {t('kanban.whatToTest', { defaultValue: 'What the agent did — to test' })}
            </div>
            <div className="max-h-64 overflow-y-auto"><Markdown text={card.latestAgentReply} /></div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {isRunning || isQueued ? (
            <Button type="button" variant="destructive" size="sm" onClick={() => void handleStop()} disabled={isBusy}>
              {busyAction === 'stop' ? <Loader2 className="animate-spin" /> : <Square />}
              {isQueued ? t('kanban.unqueue', { defaultValue: 'Remove from queue' }) : t('kanban.stop', { defaultValue: 'Stop' })}
            </Button>
          ) : (
            <>
              <Button type="button" size="sm" onClick={() => void handleRun(false)} disabled={isBusy}>
                {busyAction === 'run' ? <Loader2 className="animate-spin" /> : <Play />}
                {card.sessions.length > 0 ? t('kanban.continue', { defaultValue: 'Continue' }) : t('kanban.launch', { defaultValue: 'Launch agent' })}
              </Button>
              {card.sessions.length > 0 && (
                <Button type="button" variant="outline" size="sm" onClick={() => void handleRun(true)} disabled={isBusy}>
                  {busyAction === 'run-new' ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                  {t('kanban.newConversation', { defaultValue: 'New conversation' })}
                </Button>
              )}
              {card.column === 'review' && (
                <Button type="button" variant="outline" size="sm" onClick={() => void handleMarkDone()} disabled={isBusy}>
                  {t('kanban.markDone', { defaultValue: 'Validate → Done' })}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border/60 bg-background/60">
        <div className="border-b border-border/60 px-3 py-2 text-xs font-medium text-muted-foreground">
          {t('kanban.comments', { defaultValue: 'Comments' })}
          {card.comments.length > 0 && <span className="ml-1">({card.comments.length})</span>}
        </div>
        <div className="min-h-32 flex-1 space-y-3 overflow-y-auto p-3">
          {card.comments.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {t('kanban.noComments', { defaultValue: 'The agent\'s summary and your feedback will show up here.' })}
            </p>
          ) : (
            card.comments.map((comment) => <CommentEntry key={comment.id} comment={comment} />)
          )}
          <div ref={threadEndRef} />
        </div>
        <div className="space-y-2 border-t border-border/60 p-2">
          {commentAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {commentAttachments.map((attachment, index) => (
                <AttachmentPreview
                  key={`${attachment.path}-${index}`}
                  attachment={attachment}
                  onRemove={() => setCommentAttachments((current) => current.filter((_, i) => i !== index))}
                />
              ))}
            </div>
          )}
          <textarea
            value={commentText}
            onChange={(event) => setCommentText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void handleComment();
              }
            }}
            rows={2}
            placeholder={t('kanban.commentPlaceholder', { defaultValue: 'Feedback for the agent…' })}
            className="w-full resize-y rounded-md bg-transparent px-1 text-sm outline-none"
          />
          <div className="flex items-center gap-2">
            <input ref={commentFileInputRef} type="file" multiple className="hidden" onChange={handleCommentFiles} />
            <button
              type="button"
              onClick={() => commentFileInputRef.current?.click()}
              className="rounded p-1 text-muted-foreground hover:bg-accent"
              aria-label={t('kanban.attach', { defaultValue: 'Attach' })}
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={relaunchOnComment} onChange={(event) => setRelaunchOnComment(event.target.checked)} />
              {t('kanban.relaunchOnComment', { defaultValue: 'Relaunch the agent' })}
            </label>
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              onClick={() => void handleComment()}
              disabled={isBusy || (!commentText.trim() && commentAttachments.length === 0)}
            >
              {busyAction === 'comment' ? <Loader2 className="animate-spin" /> : <Send />}
              {t('kanban.sendComment', { defaultValue: 'Comment' })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className={`flex max-h-[94dvh] w-[calc(100vw-1rem)] flex-col overflow-hidden p-0 ${isNew ? 'max-w-2xl' : 'h-[min(94dvh,54rem)] max-w-6xl'}`}
      >
        <DialogTitle>{isNew ? t('kanban.newCard', { defaultValue: 'New card' }) : title}</DialogTitle>
        <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
          {card?.external?.key && (
            <a
              href={card.external.url ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 rounded bg-blue-500/10 px-2 py-1 font-mono text-xs font-semibold text-blue-600 hover:bg-blue-500/20 dark:text-blue-400"
              title={card.external.status ?? undefined}
            >
              {card.external.key}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          <input
            value={title}
            onChange={(event) => { setTitle(event.target.value); markDirty(); }}
            placeholder={t('kanban.titlePlaceholder', { defaultValue: 'What needs doing?' })}
            className="min-w-0 flex-1 bg-transparent text-base font-semibold outline-none placeholder:text-muted-foreground"
          />
          {card?.external?.status && (
            <span className="hidden shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground sm:inline">
              {card.external.status}
            </span>
          )}
          <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {isNew ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{cardPanel}</div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_26rem] lg:overflow-hidden">
            <div className="px-4 py-4 lg:overflow-y-auto">{cardPanel}</div>
            <div className="flex min-h-[28rem] flex-col border-t border-border/60 bg-muted/20 px-4 py-4 lg:min-h-0 lg:border-l lg:border-t-0">
              {agentPanel ?? <div className="flex flex-1 items-center justify-center"><Loader2 className="animate-spin text-muted-foreground" /></div>}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-3">
          {isNew ? (
            <>
              <span />
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void handleCreate(false)} disabled={isBusy}>
                  {busyAction === 'create' ? <Loader2 className="animate-spin" /> : <Plus />}
                  {t('kanban.create', { defaultValue: 'Create' })}
                </Button>
                <Button type="button" size="sm" onClick={() => void handleCreate(true)} disabled={isBusy}>
                  {busyAction === 'create-run' ? <Loader2 className="animate-spin" /> : <Play />}
                  {t('kanban.createAndRun', { defaultValue: 'Create and launch' })}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={() => void handleDelete()} disabled={isBusy}>
                <Trash2 /> {t('kanban.delete', { defaultValue: 'Delete' })}
              </Button>
              {isDirty && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{t('kanban.unsaved', { defaultValue: 'Unsaved changes' })}</span>
                  <Button type="button" size="sm" onClick={() => void handleSave()} disabled={isBusy}>
                    {busyAction === 'save' && <Loader2 className="animate-spin" />}
                    {t('kanban.save', { defaultValue: 'Save' })}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
