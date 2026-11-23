import { useCallback, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Clock, Loader2, MessageSquare, Paperclip, Play, Plus, RefreshCw } from 'lucide-react';

import { Button } from '@/shared/ui';
import { KANBAN_COLUMN_LABELS, KANBAN_COLUMN_ORDER } from '@/shared/constants';
import type { KanbanCard, KanbanColumnKey, Project } from '@/shared/types';
import KanbanCardDialog from '@/modules/kanban/KanbanCardDialog';
import { useKanbanBoard } from '@/modules/kanban/hooks/useKanbanBoard';

type KanbanPanelProps = {
  selectedProject: Project;
  isVisible: boolean;
  /** Opens a linked conversation in the chat tab. */
  onOpenSession: (sessionId: string) => void;
};

/** Which card the dialog shows: an existing one, or a new one to create in a column. */
type DialogTarget = { cardId: string } | { newInColumn: KanbanColumnKey } | null;

/** The drag payload type, so dropping unrelated content (files, text) on a column is ignored. */
const CARD_DRAG_TYPE = 'application/x-cloudcli-kanban-card';

function AgentStatusBadge({ card }: { card: KanbanCard }) {
  const { t } = useTranslation();
  if (card.agentStatus === 'running') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
        <Loader2 className="h-3 w-3 animate-spin" /> {t('kanban.status.running', { defaultValue: 'Agent working' })}
      </span>
    );
  }
  if (card.agentStatus === 'queued') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
        <Clock className="h-3 w-3" /> {t('kanban.status.queued', { defaultValue: 'Queued' })}
      </span>
    );
  }
  if (card.agentStatus === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
        <AlertTriangle className="h-3 w-3" /> {t('kanban.status.failed', { defaultValue: 'Failed' })}
      </span>
    );
  }
  return null;
}

function CardTile({ card, onOpen }: { card: KanbanCard; onOpen: () => void }) {
  const handleDragStart = (event: DragEvent<HTMLButtonElement>) => {
    event.dataTransfer.setData(CARD_DRAG_TYPE, card.id);
    event.dataTransfer.effectAllowed = 'move';
  };
  return (
    <button
      type="button"
      draggable
      onDragStart={handleDragStart}
      onClick={onOpen}
      className="w-full rounded-lg border border-border/60 bg-card p-2.5 text-left shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/40"
    >
      <div className="line-clamp-3 text-sm font-medium">{card.title}</div>
      {card.description && (
        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{card.description}</div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <AgentStatusBadge card={card} />
        {card.sessions.length > 0 && (
          <span className="inline-flex items-center gap-0.5"><MessageSquare className="h-3 w-3" />{card.sessions.length}</span>
        )}
        {card.commentCount > 0 && <span>💬 {card.commentCount}</span>}
        {card.attachments.length > 0 && (
          <span className="inline-flex items-center gap-0.5"><Paperclip className="h-3 w-3" />{card.attachments.length}</span>
        )}
        {card.model && <span className="truncate">{card.model}</span>}
      </div>
    </button>
  );
}

/**
 * Used by the project-workspace module as the Kanban tab: the project's board,
 * where cards are created, dragged between columns and handed to an agent.
 * The board polls while visible because agents move cards on their own.
 */
export function KanbanPanel({ selectedProject, isVisible, onOpenSession }: KanbanPanelProps) {
  const { t } = useTranslation();
  const projectId = selectedProject.projectId;
  const { cards, isLoading, error, refresh, moveCard, queueColumn } = useKanbanBoard(projectId, isVisible);
  // The card dialog's target; null when no dialog is open.
  const [dialogTarget, setDialogTarget] = useState<DialogTarget>(null);
  // The column a card is being dragged over, to highlight the drop target.
  const [dragOverColumn, setDragOverColumn] = useState<KanbanColumnKey | null>(null);
  // Feedback after queueing a column (how many cards were queued, or why it failed).
  const [queueMessage, setQueueMessage] = useState<string | null>(null);

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

  const handleDrop = (event: DragEvent<HTMLDivElement>, column: KanbanColumnKey) => {
    event.preventDefault();
    setDragOverColumn(null);
    const cardId = event.dataTransfer.getData(CARD_DRAG_TYPE);
    const card = cards.find((candidate) => candidate.id === cardId);
    if (card && card.column !== column) {
      void moveCard(cardId, column);
    }
  };

  const handleQueueTodo = async () => {
    try {
      const queued = await queueColumn('todo');
      setQueueMessage(queued > 0
        ? t('kanban.queuedCount', { count: queued, defaultValue: '{{count}} card(s) queued: the agent works through them one at a time.' })
        : t('kanban.nothingToQueue', { defaultValue: 'No card waiting in "To do".' }));
    } catch (queueError) {
      setQueueMessage(queueError instanceof Error ? queueError.message : String(queueError));
    }
  };

  const handleOpenSession = useCallback((sessionId: string) => {
    setDialogTarget(null);
    onOpenSession(sessionId);
  }, [onOpenSession]);

  const todoCount = cardsByColumn.get('todo')?.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <div className="mr-auto text-sm font-semibold">{t('kanban.title', { defaultValue: 'Board' })}</div>
        {queueMessage && <div className="text-xs text-muted-foreground">{queueMessage}</div>}
        <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} aria-label="Refresh">
          <RefreshCw />
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void handleQueueTodo()} disabled={todoCount === 0}>
          <Play /> {t('kanban.runTodo', { defaultValue: 'Run "To do"' })}
        </Button>
        <Button type="button" size="sm" onClick={() => setDialogTarget({ newInColumn: 'todo' })}>
          <Plus /> {t('kanban.newCard', { defaultValue: 'New card' })}
        </Button>
      </div>

      {error && (
        <div className="mx-3 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground"><Loader2 className="animate-spin" /></div>
      ) : (
        <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto p-3 sm:snap-none">
          {KANBAN_COLUMN_ORDER.map((column) => {
            const columnCards = cardsByColumn.get(column) ?? [];
            return (
              <div
                key={column}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes(CARD_DRAG_TYPE)) {
                    event.preventDefault();
                    setDragOverColumn(column);
                  }
                }}
                onDragLeave={() => setDragOverColumn((current) => (current === column ? null : current))}
                onDrop={(event) => handleDrop(event, column)}
                className={`flex w-[85vw] max-w-80 shrink-0 snap-start flex-col rounded-xl border bg-muted/30 sm:w-72 ${
                  dragOverColumn === column ? 'border-primary/60 bg-primary/5' : 'border-border/50'
                }`}
              >
                <div className="flex items-center justify-between px-3 py-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(`kanban.columns.${column}`, { defaultValue: KANBAN_COLUMN_LABELS[column] })}
                    <span className="ml-1.5 font-normal">{columnCards.length}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDialogTarget({ newInColumn: column })}
                    className="rounded p-1 text-muted-foreground hover:bg-accent"
                    aria-label={t('kanban.newCard', { defaultValue: 'New card' })}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                  {columnCards.map((card) => (
                    <CardTile key={card.id} card={card} onOpen={() => setDialogTarget({ cardId: card.id })} />
                  ))}
                </div>
              </div>
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
    </div>
  );
}
