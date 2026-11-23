import type { DragEvent, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  FlaskConical,
  Loader2,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  Paperclip,
} from 'lucide-react';

import { ActionMenu } from '@/shared/ui';
import { KANBAN_COLUMN_LABELS, KANBAN_COLUMN_ORDER } from '@/shared/constants';
import type { KanbanCard, KanbanColumnKey } from '@/shared/types';
import { formatRelativeTime } from '@/shared/utils';

/** Drag payload type, so dropping unrelated content (files, text) on a column is ignored. */
export const KANBAN_CARD_DRAG_TYPE = 'application/x-cloudcli-kanban-card';

/** Accent of the left edge, which is how a card's agent state reads at a glance. */
const STATUS_ACCENTS: Record<KanbanCard['agentStatus'], string> = {
  idle: 'bg-transparent',
  queued: 'bg-slate-400',
  running: 'bg-primary animate-pulse',
  failed: 'bg-amber-500',
};

const PRIORITY_COLORS: Record<string, string> = {
  highest: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-sky-500',
  lowest: 'bg-slate-400',
};

/** Markdown noise removed from the one-line previews. */
function plainPreview(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>[\]]/g, '').replace(/\(https?:[^)]+\)/g, '').replace(/\s+/g, ' ').trim();
}

type KanbanCardTileProps = {
  card: KanbanCard;
  onOpen: () => void;
  onMove: (column: KanbanColumnKey) => void;
};

/** Rendered by KanbanPanel for each card of a column. */
export default function KanbanCardTile({ card, onOpen, onMove }: KanbanCardTileProps) {
  const { t, i18n } = useTranslation();
  const columnLabel = (key: KanbanColumnKey) => t(`kanban.columns.${key}`, { defaultValue: KANBAN_COLUMN_LABELS[key] });
  const priorityColor = card.external?.priority ? PRIORITY_COLORS[card.external.priority.toLowerCase()] : undefined;

  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData(KANBAN_CARD_DRAG_TYPE, card.id);
    event.dataTransfer.effectAllowed = 'move';
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={handleDragStart}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      className="group relative cursor-pointer overflow-hidden rounded-lg border border-border/70 bg-card p-3 text-left shadow-sm transition-all hover:-translate-y-px hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${STATUS_ACCENTS[card.agentStatus]}`} />

      <div
        className="absolute right-1.5 top-1.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
        onClick={(event) => event.stopPropagation()}
      >
        <ActionMenu
          label={t('kanban.moveTo', { defaultValue: 'Move to' })}
          ariaLabel={t('kanban.moveTo', { defaultValue: 'Move to' })}
          icon={MoreHorizontal}
          iconOnly
          variant="ghost"
          portal
          triggerClassName="h-6 w-6 p-0"
          header={<div className="px-3 py-1.5 text-xs text-muted-foreground">{t('kanban.moveTo', { defaultValue: 'Move to' })}</div>}
          items={KANBAN_COLUMN_ORDER.filter((key) => key !== card.column).map((key) => ({
            key,
            label: columnLabel(key),
            icon: ArrowRight,
            onSelect: () => onMove(key),
          }))}
        />
      </div>

      {(card.external?.key || card.external?.type || priorityColor) && (
        <div className="mb-1.5 flex items-center gap-1.5 pr-7">
          {card.external?.key && (
            <span className="rounded bg-blue-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-blue-600 dark:text-blue-400">
              {card.external.key}
            </span>
          )}
          {card.external?.type && <span className="truncate text-[10px] text-muted-foreground">{card.external.type}</span>}
          {priorityColor && (
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${priorityColor}`} title={card.external?.priority ?? undefined} />
          )}
        </div>
      )}

      <div className={`line-clamp-3 text-sm font-medium leading-snug ${card.external?.key ? '' : 'pr-7'}`}>{card.title}</div>
      {card.description && card.column !== 'review' && (
        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{plainPreview(card.description)}</div>
      )}

      {card.column === 'review' && card.latestAgentReply && (
        <div className="mt-2 rounded-md border border-violet-500/20 bg-violet-500/5 p-2">
          <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
            <FlaskConical className="h-3 w-3" /> {t('kanban.toTestSummary', { defaultValue: 'To test' })}
          </div>
          <div className="line-clamp-4 text-xs text-foreground/80">{plainPreview(card.latestAgentReply)}</div>
        </div>
      )}

      {card.external && card.external.labels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {card.external.labels.slice(0, 3).map((label) => (
            <span key={label} className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{label}</span>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2.5 text-[11px] text-muted-foreground">
        {card.agentStatus === 'running' && (
          <span className="inline-flex items-center gap-1 font-medium text-primary">
            <Loader2 className="h-3 w-3 animate-spin" /> {t('kanban.status.running', { defaultValue: 'Agent working' })}
          </span>
        )}
        {card.agentStatus === 'queued' && (
          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {t('kanban.status.queued', { defaultValue: 'Queued' })}</span>
        )}
        {card.agentStatus === 'failed' && (
          <span className="inline-flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400" title={card.agentError ?? undefined}>
            <AlertTriangle className="h-3 w-3" /> {t('kanban.status.failed', { defaultValue: 'Failed' })}
          </span>
        )}
        {card.sessions.length > 0 && (
          <span className="inline-flex items-center gap-0.5" title={t('kanban.conversations', { defaultValue: 'Conversations' })}>
            <MessagesSquare className="h-3 w-3" />{card.sessions.length}
          </span>
        )}
        {card.commentCount > 0 && (
          <span className="inline-flex items-center gap-0.5" title={t('kanban.comments', { defaultValue: 'Comments' })}>
            <MessageSquare className="h-3 w-3" />{card.commentCount}
          </span>
        )}
        {card.attachments.length > 0 && (
          <span className="inline-flex items-center gap-0.5"><Paperclip className="h-3 w-3" />{card.attachments.length}</span>
        )}
        {card.model && <span className="truncate rounded bg-muted px-1 font-mono text-[10px]">{card.model}</span>}
        <span className="ml-auto shrink-0">{formatRelativeTime(card.updatedAt, i18n.language)}</span>
      </div>
    </div>
  );
}
