import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { KanbanCard, KanbanColumnKey } from '@/shared/types';

/**
 * How often the board refreshes while it is on screen. The agent moves cards
 * on its own (running → review), and there is no realtime event for it, so the
 * board polls; a few seconds is plenty for a view the user glances at.
 */
const BOARD_POLL_INTERVAL_MS = 4000;

type BoardResponse = { data: { columns: KanbanColumnKey[]; cards: KanbanCard[] } };

/** Loads one project's board, keeps it fresh while visible, and exposes the card moves. */
export function useKanbanBoard(projectId: string | null, isVisible: boolean) {
  // The board as last read from the server; every mutation re-reads it.
  const [cards, setCards] = useState<KanbanCard[]>([]);
  // True only until the first read of a project lands, so polls never flash a spinner.
  const [isLoading, setIsLoading] = useState(true);
  // The last load failure, shown above the board until a read succeeds.
  const [error, setError] = useState<string | null>(null);
  // Ignores a response for a project the user has since navigated away from.
  const requestedProjectRef = useRef<string | null>(projectId);

  const refresh = useCallback(async () => {
    if (!projectId) {
      return;
    }
    requestedProjectRef.current = projectId;
    try {
      const body = await readApiJson<BoardResponse>(await api.kanban.board(projectId));
      if (requestedProjectRef.current !== projectId) {
        return;
      }
      setCards(body.data.cards);
      setError(null);
    } catch (loadError) {
      if (requestedProjectRef.current === projectId) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (requestedProjectRef.current === projectId) {
        setIsLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    setCards([]);
    setIsLoading(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isVisible || !projectId) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    }, BOARD_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isVisible, projectId, refresh]);

  /** Moves a card to a column, optimistically, then re-reads the board. */
  const moveCard = useCallback(async (cardId: string, column: KanbanColumnKey, position?: number) => {
    setCards((current) => current.map((card) => (
      card.id === cardId ? { ...card, column, position: position ?? Number.MAX_SAFE_INTEGER } : card
    )));
    try {
      await readApiJson(await api.kanban.updateCard(cardId, position === undefined ? { column } : { column, position }));
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : String(moveError));
    }
    await refresh();
  }, [refresh]);

  /** Queues every card of a column for the agent, one after the other. */
  const queueColumn = useCallback(async (column: KanbanColumnKey): Promise<number> => {
    if (!projectId) {
      return 0;
    }
    const body = await readApiJson<{ data: { queued: number } }>(await api.kanban.queue(projectId, { column }));
    await refresh();
    return body.data.queued;
  }, [projectId, refresh]);

  return { cards, isLoading, error, refresh, moveCard, queueColumn };
}
