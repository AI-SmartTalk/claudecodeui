import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Info, MessageSquare, Wrench } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { KanbanActivity, KanbanActivityStep } from '@/shared/types';
import { formatRelativeTime } from '@/shared/utils';

/** Refresh rate of the live strip; short because it is only polled while the agent works. */
const ACTIVITY_POLL_INTERVAL_MS = 2000;

const STEP_ICONS: Record<KanbanActivityStep['kind'], typeof Wrench> = {
  tool: Wrench,
  text: MessageSquare,
  status: Info,
};

type KanbanAgentActivityProps = {
  /** Whose activity to follow: a card's agent, or a conversation (planning runs). */
  source: { cardId: string } | { sessionId: string };
  onOpenSession: (sessionId: string) => void;
  /** Heading of the strip; defaults to "the agent is working". */
  title?: string;
};

/**
 * Rendered by the card dialog and the board's planning strip while an agent works: its last few steps
 * (tool calls, messages) read from the live run, and a shortcut to follow the
 * conversation in the chat.
 */
export default function KanbanAgentActivity({ source, onOpenSession, title }: KanbanAgentActivityProps) {
  const { t, i18n } = useTranslation();
  // The latest live view of the run; null until the first poll answers.
  const [activity, setActivity] = useState<KanbanActivity | null>(null);

  const sourceKey = 'cardId' in source ? `card:${source.cardId}` : `session:${source.sessionId}`;

  useEffect(() => {
    let cancelled = false;
    const [kind, id] = [sourceKey.slice(0, sourceKey.indexOf(':')), sourceKey.slice(sourceKey.indexOf(':') + 1)];
    const poll = async () => {
      try {
        const response = kind === 'card' ? await api.kanban.activity(id) : await api.kanban.sessionActivity(id);
        const body = await readApiJson<{ data: KanbanActivity }>(response);
        if (!cancelled) setActivity(body.data);
      } catch {
        // A missed poll is retried on the next tick.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), ACTIVITY_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sourceKey]);

  const steps = activity?.steps ?? [];

  return (
    <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
        </span>
        <span className="text-sm font-medium">{title ?? t('kanban.activity.working', { defaultValue: 'The agent is working' })}</span>
        {activity?.sessionId && (
          <button
            type="button"
            onClick={() => onOpenSession(activity.sessionId as string)}
            className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {t('kanban.activity.follow', { defaultValue: 'Follow live' })}
            <ExternalLink className="h-3 w-3" />
          </button>
        )}
      </div>
      {steps.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('kanban.activity.starting', { defaultValue: 'Starting… the first steps will show up here.' })}
        </p>
      ) : (
        <ol className="space-y-1.5">
          {steps.map((step, index) => {
            const Icon = STEP_ICONS[step.kind];
            return (
              <li
                key={`${step.at}-${index}`}
                className={`flex items-start gap-2 text-xs ${index === 0 ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{step.label}</span>
                  {step.detail && <span className="ml-1.5 break-all font-mono opacity-80">{step.detail}</span>}
                </span>
                {step.at && <span className="shrink-0 opacity-60">{formatRelativeTime(step.at, i18n.language)}</span>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
