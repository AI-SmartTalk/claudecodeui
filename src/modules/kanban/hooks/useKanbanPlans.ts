import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { KanbanPlan } from '@/shared/types';

/** Refresh rate of the planning strip; plans are few and short-lived. */
const PLANS_POLL_INTERVAL_MS = 4000;

/** How long a finished planning run stays on the board before it is hidden. */
const FINISHED_PLAN_VISIBLE_MS = 10 * 60_000;

/** The project's recent planning runs, polled while the board is visible. */
export function useKanbanPlans(projectId: string | null, isVisible: boolean) {
  // Recent planning runs (running ones and those finished in the last minutes).
  const [plans, setPlans] = useState<KanbanPlan[]>([]);
  // Finished runs the user dismissed from the strip.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const body = await readApiJson<{ data: KanbanPlan[] }>(await api.kanban.plans(projectId));
      // Age is judged at fetch time (not during render), so finished runs fade out on the next poll.
      const now = Date.now();
      setPlans(body.data.filter((plan) => plan.running || now - new Date(plan.startedAt).getTime() < FINISHED_PLAN_VISIBLE_MS));
    } catch {
      // The strip is a progress hint; a failed poll is retried.
    }
  }, [projectId]);

  useEffect(() => {
    if (!isVisible) return undefined;
    void refresh();
    const timer = window.setInterval(() => void refresh(), PLANS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isVisible, refresh]);

  const visible = plans.filter((plan) => !dismissed.has(plan.sessionId));

  const dismiss = useCallback((sessionId: string) => {
    setDismissed((current) => new Set(current).add(sessionId));
  }, []);

  return { plans: visible, refresh, dismiss };
}
