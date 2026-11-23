import { useCallback, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Play, PlugZap, Plus, RefreshCw } from 'lucide-react';

import { Button } from '@/shared/ui';
import { KANBAN_COLUMN_LABELS, KANBAN_COLUMN_ORDER } from '@/shared/constants';
import type { KanbanCard, KanbanColumnKey, Project } from '@/shared/types';
import { formatRelativeTime } from '@/shared/utils';
import KanbanCardTile, { KANBAN_CARD_DRAG_TYPE } from '@/modules/kanban/KanbanCardTile';
import KanbanCardDialog from '@/modules/kanban/modals/KanbanCardDialog';
import KanbanConnectorDialog from '@/modules/kanban/modals/KanbanConnectorDialog';
import { useKanbanBoard } from '@/modules/kanban/hooks/useKanbanBoard';
import { useKanbanConnector } from '@/modules/kanban/hooks/useKanbanConnector';

type KanbanPanelProps = {
  selectedProject: Project;
  isVisible: boolean;
  /** Opens a linked conversation in the chat tab. */
  onOpenSession: (sessionId: string) => void;
};

/** Which card the dialog shows: an existing one, or a new one to create in a column. */
type DialogTarget = { cardId: string } | { newInColumn: KanbanColumnKey } | null;

/** Colour of each column's dot and drop highlight, so columns read apart at a glance. */
const COLUMN_DOTS: Record<KanbanColumnKey, string> = {
  backlog: 'bg-slate-400',
  todo: 'bg-sky-500',
  in_progress: 'bg-amber-500',
  review: 'bg-violet-500',
  done: 'bg-emerald-500',
};

/** One-line explanation under each empty column. */
const EMPTY_HINTS: Record<KanbanColumnKey, string> = {
  backlog: 'Ideas and tickets not planned yet.',
  todo: 'What the agent should pick up next.',
  in_progress: 'Cards the agent is working on.',
  review: 'Finished by the agent — your turn to test.',
  done: 'Tested and validated.',
};

/**
 * Used by the project-workspace module as the Kanban tab: the project's board,
 * where cards are created, moved between columns and handed to an agent, and
 * where the project's external tracker is linked. The board polls while
 * visible because agents (and the tracker sync) move cards on their own.
 */
export function KanbanPanel({ selectedProject, isVisible, onOpenSession }: KanbanPanelProps) {
  const { t, i18n } = useTranslation();
  const projectId = selectedProject.projectId;
  const { cards, isLoading, error, refresh, moveCard, queueColumn } = useKanbanBoard(projectId, isVisible);
  const { connector, isSyncing, syncMessage, setSyncMessage, refresh: refreshConnector, sync } = useKanbanConnector(projectId, () => void refresh());
  // The card dialog's target; null when no dialog is open.
  const [dialogTarget, setDialogTarget] = useState<DialogTarget>(null);
  // Whether the external-source settings are open.
  const [isConnectorOpen, setIsConnectorOpen] = useState(false);
  // The column a card is being dragged over, to highlight the drop target.
  const [dragOverColumn, setDragOverColumn] = useState<KanbanColumnKey | null>(null);
  // Feedback after queueing a column or syncing (counts, or why it failed).
  const [notice, setNotice] = useState<string | null>(null);

  const cardsByColumn = useMemo(() => {
    const grouped = new Map<KanbanColumnKey, KanbanCard[]>(KANBAN_COLUMN_ORDER.map((key) => [key, []]));
    for (const card of cards) {
      grouped.get(card.column)?.push(card);
    }
    for (const list of grouped.values()) {
      list.sort((left, right) => left.position - right.position);
    }
    return grouped;
  }, [cards]);

  const columnLabel = (key: KanbanColumnKey) => t(`kanban.columns.${key}`, { defaultValue: KANBAN_COLUMN_LABELS[key] });
  const runningCount = cards.filter((card) => card.agentStatus === 'running').length;
  const queuedCount = cards.filter((card) => card.agentStatus === 'queued').length;
  const reviewCount = cardsByColumn.get('review')?.length ?? 0;
  const todoCount = cardsByColumn.get('todo')?.length ?? 0;

  const handleDrop = (event: DragEvent<HTMLElement>, column: KanbanColumnKey) => {
    event.preventDefault();
    setDragOverColumn(null);
    const cardId = event.dataTransfer.getData(KANBAN_CARD_DRAG_TYPE);
    const card = cards.find((candidate) => candidate.id === cardId);
    if (card && card.column !== column) {
      void moveCard(cardId, column);
    }
  };

  const handleQueueTodo = async () => {
    try {
      const queued = await queueColumn('todo');
      setNotice(queued > 0
        ? t('kanban.queuedCount', { count: queued, defaultValue: '{{count}} card(s) queued: the agent works through them one at a time.' })
        : t('kanban.nothingToQueue', { defaultValue: 'No card waiting in "To do".' }));
    } catch (queueError) {
      setNotice(queueError instanceof Error ? queueError.message : String(queueError));
    }
  };

  const handleSync = async () => {
    setNotice(null);
    const result = await sync();
    if (result) {
      setNotice(t('kanban.connector.syncResult', {
        defaultValue: '{{total}} tickets · {{created}} new · {{updated}} updated',
        total: result.total,
        created: result.created,
        updated: result.updated,
      }));
    }
  };

  const handleOpenSession = useCallback((sessionId: string) => {
    setDialogTarget(null);
    onOpenSession(sessionId);
  }, [onOpenSession]);

  const sourceLabel = connector
    ? `Jira${typeof connector.config.projectKey === 'string' && connector.config.projectKey ? ` · ${connector.config.projectKey}` : ''}`
    : t('kanban.connector.link', { defaultValue: 'Link a source' });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <div className="mr-auto min-w-0">
          <div className="text-sm font-semibold">{t('kanban.title', { defaultValue: 'Board' })}</div>
          <div className="truncate text-xs text-muted-foreground">
            {[
              runningCount > 0 && t('kanban.summary.running', { count: runningCount, defaultValue: '{{count}} in progress' }),
              queuedCount > 0 && t('kanban.summary.queued', { count: queuedCount, defaultValue: '{{count}} queued' }),
              reviewCount > 0 && t('kanban.summary.review', { count: reviewCount, defaultValue: '{{count}} to test' }),
            ].filter(Boolean).join(' · ') || t('kanban.summary.idle', { defaultValue: '{{count}} cards', count: cards.length })}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIsConnectorOpen(true)}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-input px-3 text-sm hover:bg-accent"
          title={connector?.lastSyncError ?? undefined}
        >
          <PlugZap className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <span>{sourceLabel}</span>
          {connector && (
            <span className={`h-2 w-2 rounded-full ${connector.lastSyncError ? 'bg-destructive' : connector.enabled ? 'bg-emerald-500' : 'bg-slate-400'}`} />
          )}
          {connector?.lastSyncAt && !connector.lastSyncError && (
            <span className="hidden text-xs text-muted-foreground md:inline">{formatRelativeTime(connector.lastSyncAt, i18n.language)}</span>
          )}
        </button>
        {connector && (
          <Button type="button" variant="outline" size="sm" onClick={() => void handleSync()} disabled={isSyncing} aria-label={t('kanban.connector.syncNow', { defaultValue: 'Sync now' })}>
            <RefreshCw className={isSyncing ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">{t('kanban.connector.syncNow', { defaultValue: 'Sync now' })}</span>
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={() => void handleQueueTodo()} disabled={todoCount === 0}>
          <Play /> <span className="hidden sm:inline">{t('kanban.runTodo', { defaultValue: 'Run "To do"' })}</span>
        </Button>
        <Button type="button" size="sm" onClick={() => setDialogTarget({ newInColumn: 'todo' })}>
          <Plus /> <span className="hidden sm:inline">{t('kanban.newCard', { defaultValue: 'New card' })}</span>
        </Button>
      </div>

      {(notice || syncMessage || error) && (
        <div className="flex items-center gap-2 border-b border-border/40 bg-muted/40 px-3 py-1.5 text-xs">
          <span className={`min-w-0 flex-1 ${error || syncMessage ? 'text-destructive' : 'text-muted-foreground'}`}>
            {error ?? syncMessage ?? notice}
          </span>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => { setNotice(null); setSyncMessage(null); }}>
            ✕
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground"><Loader2 className="animate-spin" /></div>
      ) : (
        <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto p-3 sm:snap-none">
          {KANBAN_COLUMN_ORDER.map((column) => {
            const columnCards = cardsByColumn.get(column) ?? [];
            const isDropTarget = dragOverColumn === column;
            return (
              <section
                key={column}
                aria-label={columnLabel(column)}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes(KANBAN_CARD_DRAG_TYPE)) {
                    event.preventDefault();
                    setDragOverColumn(column);
                  }
                }}
                onDragLeave={() => setDragOverColumn((current) => (current === column ? null : current))}
                onDrop={(event) => handleDrop(event, column)}
                className={`flex w-[85vw] max-w-80 shrink-0 snap-center flex-col rounded-xl border transition-colors sm:w-72 ${
                  isDropTarget ? 'border-primary/60 bg-primary/5' : 'border-border/50 bg-muted/30'
                }`}
              >
                <header className="flex items-center gap-2 px-3 pb-2 pt-3">
                  <span className={`h-2 w-2 rounded-full ${COLUMN_DOTS[column]}`} />
                  <span className="text-xs font-semibold uppercase tracking-wide">{columnLabel(column)}</span>
                  <span className="rounded-full bg-background px-1.5 text-[11px] font-medium text-muted-foreground">{columnCards.length}</span>
                  <button
                    type="button"
                    onClick={() => setDialogTarget({ newInColumn: column })}
                    className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={t('kanban.newCard', { defaultValue: 'New card' })}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </header>
                <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                  {columnCards.map((card) => (
                    <KanbanCardTile
                      key={card.id}
                      card={card}
                      onOpen={() => setDialogTarget({ cardId: card.id })}
                      onMove={(target) => void moveCard(card.id, target)}
                    />
                  ))}
                  {columnCards.length === 0 && (
                    <button
                      type="button"
                      onClick={() => setDialogTarget({ newInColumn: column })}
                      className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground ${
                        isDropTarget ? 'border-primary/60' : 'border-border'
                      }`}
                    >
                      <span>{t(`kanban.empty.${column}`, { defaultValue: EMPTY_HINTS[column] })}</span>
                      <span className="inline-flex items-center gap-1 font-medium"><Plus className="h-3 w-3" />{t('kanban.add', { defaultValue: 'Add' })}</span>
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {dialogTarget && (
        <KanbanCardDialog
          projectId={projectId}
          cardId={'cardId' in dialogTarget ? dialogTarget.cardId : null}
          initialColumn={'newInColumn' in dialogTarget ? dialogTarget.newInColumn : 'todo'}
          onClose={() => { setDialogTarget(null); void refresh(); }}
          onChanged={() => void refresh()}
          onOpenSession={handleOpenSession}
        />
      )}

      {isConnectorOpen && (
        <KanbanConnectorDialog
          projectId={projectId}
          connector={connector}
          onClose={() => setIsConnectorOpen(false)}
          onSaved={(syncNow) => {
            setIsConnectorOpen(false);
            void refreshConnector();
            if (syncNow) void handleSync();
          }}
        />
      )}
    </div>
  );
}
