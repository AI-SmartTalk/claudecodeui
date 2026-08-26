import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatElapsed } from '../../utils/backgroundAgents';
import type { RunningBackgroundAgent } from '../../utils/backgroundAgents';

interface BackgroundAgentsBannerProps {
  agents: RunningBackgroundAgent[];
}

/**
 * Surfaces subagents that are still working, mirroring the CLI's status line.
 *
 * Without this the only sign of a running background agent is its container far
 * up the transcript, which is easy to scroll past — and the parent session often
 * sits idle waiting on it, so nothing else moves on screen.
 */
export default function BackgroundAgentsBanner({ agents }: BackgroundAgentsBannerProps) {
  const { t } = useTranslation('chat');
  const [nowMs, setNowMs] = useState(() => Date.now());

  const hasAgents = agents.length > 0;

  useEffect(() => {
    if (!hasAgents) {
      return;
    }

    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasAgents]);

  if (!hasAgents) {
    return null;
  }

  return (
    <div className="rounded-lg border border-purple-300/70 bg-purple-50/70 px-3 py-2 dark:border-purple-800/70 dark:bg-purple-950/30">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" />
        <span className="text-xs font-medium text-purple-900 dark:text-purple-100">
          {t('backgroundAgents.title', {
            count: agents.length,
            defaultValue_one: '{{count}} background agent running',
            defaultValue_other: '{{count}} background agents running',
          })}
        </span>
      </div>

      <ul className="mt-1 space-y-0.5">
        {agents.map((agent) => (
          <li key={agent.toolId} className="flex items-baseline gap-2 pl-3.5 text-xs">
            <span className="truncate text-purple-900 dark:text-purple-100">{agent.description}</span>
            <span className="flex-shrink-0 font-mono text-[11px] text-purple-700/80 dark:text-purple-300/80">
              {agent.agentType} · {formatElapsed(agent.startedAt.getTime(), nowMs)}
              {agent.toolCount > 0 && ` · ${t('backgroundAgents.tools', {
                count: agent.toolCount,
                defaultValue_one: '{{count}} tool',
                defaultValue_other: '{{count}} tools',
              })}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
