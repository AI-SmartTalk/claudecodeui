import { useMemo } from 'react';

import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { Markdown } from '@/modules/chat/transcript/Markdown';

type ProjectMarkdownProps = {
  /** DB projectId the images and file links in the text resolve against. */
  projectId: string;
  children: string;
  className?: string;
  /** Render single newlines as hard line breaks (user-typed text). */
  breaks?: boolean;
};

/**
 * Used by the kanban module to render card descriptions, comments and agent
 * replies exactly like chat messages: code highlighting, Mermaid, math, and
 * images or file links the agent references by workspace path.
 */
export function ProjectMarkdown({ projectId, children, className, breaks }: ProjectMarkdownProps) {
  const value = useMemo(() => ({ projectId }), [projectId]);
  return (
    <MarkdownWorkspaceContext.Provider value={value}>
      <Markdown className={className} breaks={breaks}>{children}</Markdown>
    </MarkdownWorkspaceContext.Provider>
  );
}
