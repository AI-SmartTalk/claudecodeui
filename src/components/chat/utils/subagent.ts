/**
 * Claude Code renamed the subagent-spawning tool from `Task` to `Agent`: the SDK
 * now ships an `AgentInput` (carrying `subagent_type`) and has reused the `Task`
 * prefix for unrelated background-task tools (`TaskCreate`, `TaskStop`, …).
 * Both names are recognised so live sessions and transcripts written by older
 * releases nest their child tools identically.
 */
export function isSubagentToolName(toolName?: string | null): boolean {
  return toolName === 'Agent' || toolName === 'Task';
}
