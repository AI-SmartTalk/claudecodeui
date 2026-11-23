import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { KanbanConnector } from '@/shared/types';

/** Loads the external tracker linked to a project and runs on-demand syncs. */
export function useKanbanConnector(projectId: string | null, onSynced: () => void) {
  // The linked tracker, or null when the board is local-only.
  const [connector, setConnector] = useState<KanbanConnector | null>(null);
  // True while a manual sync runs, to spin the sync button.
  const [isSyncing, setIsSyncing] = useState(false);
  // Outcome of the last manual sync, shown next to the source button.
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const body = await readApiJson<{ data: KanbanConnector | null }>(await api.kanban.connector(projectId));
      setConnector(body.data);
    } catch {
      // The board works without its tracker; the source button just shows "link".
    }
  }, [projectId]);

  useEffect(() => {
    setConnector(null);
    void refresh();
  }, [refresh]);

  const sync = useCallback(async (): Promise<{ created: number; updated: number; total: number } | null> => {
    if (!projectId) return null;
    setIsSyncing(true);
    setSyncMessage(null);
    try {
      const body = await readApiJson<{ data: { created: number; updated: number; total: number } }>(
        await api.kanban.syncConnector(projectId),
      );
      onSynced();
      return body.data;
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setIsSyncing(false);
      void refresh();
    }
  }, [onSynced, projectId, refresh]);

  return { connector, isSyncing, syncMessage, setSyncMessage, refresh, sync };
}
