import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ExternalLink, Loader2, PlugZap, RefreshCw, Trash2, X } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { KANBAN_COLUMN_LABELS, KANBAN_COLUMN_ORDER } from '@/shared/constants';
import type { KanbanColumnKey, KanbanConnector, KanbanTrackerStatus } from '@/shared/types';
import { formatRelativeTime } from '@/shared/utils';

/** Where Atlassian users create the API token the connector needs. */
const JIRA_TOKEN_HELP_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

type KanbanConnectorDialogProps = {
  projectId: string;
  connector: KanbanConnector | null;
  onClose: () => void;
  /** Called after a save or unlink, with whether a sync should follow. */
  onSaved: (syncNow: boolean) => void;
};

function readText(config: Record<string, unknown>, key: string): string {
  return typeof config[key] === 'string' ? config[key] as string : '';
}

const inputClass = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring';

/**
 * Rendered by KanbanPanel to link the board to an external tracker (Jira Cloud
 * today): credentials, which tickets to import, how statuses map to columns,
 * and what flows back to the tracker.
 */
export default function KanbanConnectorDialog({ projectId, connector, onClose, onSaved }: KanbanConnectorDialogProps) {
  const { t, i18n } = useTranslation();
  const initial = connector?.config ?? {};
  // Form fields, seeded from the stored connector; the token is write-only and starts empty.
  const [baseUrl, setBaseUrl] = useState(readText(initial, 'baseUrl'));
  const [email, setEmail] = useState(readText(initial, 'email'));
  const [secret, setSecret] = useState('');
  const [projectKey, setProjectKey] = useState(readText(initial, 'projectKey'));
  const [jql, setJql] = useState(readText(initial, 'jql'));
  const [importDone, setImportDone] = useState(initial.importDone === true);
  const [pushStatus, setPushStatus] = useState(initial.pushStatus !== false);
  const [postAgentComments, setPostAgentComments] = useState(initial.postAgentComments !== false);
  const [enabled, setEnabled] = useState(connector?.enabled ?? true);
  // Status name → column, edited after a connection test lists the statuses.
  const [statusMapping, setStatusMapping] = useState<Record<string, KanbanColumnKey>>(
    (initial.statusMapping as Record<string, KanbanColumnKey> | undefined) ?? {},
  );
  // Result of the last connection test: the account and the statuses found.
  const [testResult, setTestResult] = useState<{ account: string; statuses: KanbanTrackerStatus[] } | null>(null);
  // Whether the advanced JQL field is shown.
  const [showAdvanced, setShowAdvanced] = useState(Boolean(readText(initial, 'jql')));
  // The action in flight and the last error, for the footer.
  const [busy, setBusy] = useState<'test' | 'save' | 'save-sync' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const config = () => ({
    baseUrl: baseUrl.trim(),
    email: email.trim(),
    projectKey: projectKey.trim().toUpperCase() || null,
    jql: jql.trim() || null,
    importDone,
    pushStatus,
    postAgentComments,
    statusMapping,
  });

  const run = async (name: NonNullable<typeof busy>, action: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(null);
    }
  };

  const handleTest = () => run('test', async () => {
    const body = await readApiJson<{ data: { account: string; statuses: KanbanTrackerStatus[] } }>(
      await api.kanban.testConnector(projectId, { type: 'jira', config: config(), secret: secret.trim() || undefined }),
    );
    setTestResult(body.data);
    // Make the defaults explicit so the mapping table reflects what will happen.
    setStatusMapping((current) => {
      const next = { ...current };
      for (const status of body.data.statuses) {
        next[status.name] = current[status.name] ?? status.column;
      }
      return next;
    });
  });

  const handleSave = (syncNow: boolean) => run(syncNow ? 'save-sync' : 'save', async () => {
    await readApiJson(await api.kanban.saveConnector(projectId, {
      type: 'jira',
      config: config(),
      secret: secret.trim() || undefined,
      enabled,
    }));
    onSaved(syncNow);
  });

  const handleDelete = () => run('delete', async () => {
    if (!window.confirm(t('kanban.connector.confirmUnlink', { defaultValue: 'Unlink this source? Imported cards stay on the board.' }))) {
      return;
    }
    await readApiJson(await api.kanban.deleteConnector(projectId));
    onSaved(false);
  });

  const columnLabel = (key: KanbanColumnKey) => t(`kanban.columns.${key}`, { defaultValue: KANBAN_COLUMN_LABELS[key] });
  const canSubmit = Boolean(baseUrl.trim() && email.trim() && (projectKey.trim() || jql.trim()) && (secret.trim() || connector?.hasSecret));

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[92dvh] w-[calc(100vw-1rem)] max-w-2xl flex-col overflow-hidden p-0">
        <DialogTitle>{t('kanban.connector.title', { defaultValue: 'External source' })}</DialogTitle>
        <div className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
            <PlugZap className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{t('kanban.connector.title', { defaultValue: 'External source' })}</div>
            <div className="text-xs text-muted-foreground">
              {t('kanban.connector.subtitle', { defaultValue: 'Import tickets as cards and keep their status in sync.' })}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-3 gap-2">
            <button type="button" className="rounded-lg border-2 border-primary bg-primary/5 px-3 py-2 text-left">
              <div className="text-sm font-medium">Jira Cloud</div>
              <div className="text-[11px] text-muted-foreground">Atlassian</div>
            </button>
            {['Linear', 'GitHub Issues'].map((name) => (
              <div key={name} className="cursor-not-allowed rounded-lg border border-dashed border-border px-3 py-2 opacity-60">
                <div className="text-sm font-medium">{name}</div>
                <div className="text-[11px] text-muted-foreground">{t('kanban.connector.soon', { defaultValue: 'Coming soon' })}</div>
              </div>
            ))}
          </div>

          {connector && (
            <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${connector.lastSyncError ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}>
              {connector.lastSyncError
                ? connector.lastSyncError
                : connector.lastSyncAt
                  ? t('kanban.connector.lastSync', {
                    defaultValue: 'Last sync {{when}} · {{count}} tickets',
                    when: formatRelativeTime(connector.lastSyncAt, i18n.language),
                    count: connector.lastSyncCount ?? 0,
                  })
                  : t('kanban.connector.neverSynced', { defaultValue: 'Not synced yet' })}
            </div>
          )}

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('kanban.connector.account', { defaultValue: 'Account' })}
            </h3>
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>{t('kanban.connector.siteUrl', { defaultValue: 'Site URL' })}</span>
              <input className={inputClass} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://your-team.atlassian.net" />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block space-y-1 text-xs text-muted-foreground">
                <span>Email</span>
                <input className={inputClass} type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" />
              </label>
              <label className="block space-y-1 text-xs text-muted-foreground">
                <span className="flex items-center justify-between">
                  {t('kanban.connector.token', { defaultValue: 'API token' })}
                  <a href={JIRA_TOKEN_HELP_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                    {t('kanban.connector.createToken', { defaultValue: 'Create one' })} <ExternalLink className="h-3 w-3" />
                  </a>
                </span>
                <input
                  className={inputClass}
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder={connector?.hasSecret ? t('kanban.connector.tokenSaved', { defaultValue: '•••••• saved — leave empty to keep' }) : ''}
                />
              </label>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('kanban.connector.tickets', { defaultValue: 'Tickets to import' })}
            </h3>
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>{t('kanban.connector.projectKey', { defaultValue: 'Jira project key' })}</span>
              <input className={`${inputClass} uppercase`} value={projectKey} onChange={(event) => setProjectKey(event.target.value)} placeholder="APP" />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={importDone} onChange={(event) => setImportDone(event.target.checked)} />
              {t('kanban.connector.importDone', { defaultValue: 'Also import finished tickets' })}
            </label>
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowAdvanced((value) => !value)}>
              {showAdvanced ? t('kanban.connector.hideJql', { defaultValue: 'Hide custom JQL' }) : t('kanban.connector.showJql', { defaultValue: 'Use a custom JQL query' })}
            </button>
            {showAdvanced && (
              <label className="block space-y-1 text-xs text-muted-foreground">
                <span>JQL</span>
                <textarea
                  className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground"
                  rows={2}
                  value={jql}
                  onChange={(event) => setJql(event.target.value)}
                  placeholder='project = APP AND assignee = currentUser() AND statusCategory != Done'
                />
                <span>{t('kanban.connector.jqlHelp', { defaultValue: 'Overrides the project key when set.' })}</span>
              </label>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('kanban.connector.mapping', { defaultValue: 'Status → column' })}
              </h3>
              <Button type="button" variant="outline" size="sm" onClick={() => void handleTest()} disabled={!canSubmit || busy !== null}>
                {busy === 'test' ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                {t('kanban.connector.test', { defaultValue: 'Test connection' })}
              </Button>
            </div>
            {testResult ? (
              <div className="overflow-hidden rounded-lg border border-border/60">
                <div className="border-b border-border/60 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
                  {t('kanban.connector.connectedAs', { defaultValue: 'Connected as {{account}}', account: testResult.account })}
                </div>
                {testResult.statuses.map((status) => (
                  <div key={status.name} className="flex items-center gap-3 border-b border-border/40 px-3 py-1.5 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate text-sm">{status.name}</span>
                    <span className="text-xs text-muted-foreground">→</span>
                    <select
                      value={statusMapping[status.name] ?? status.column}
                      onChange={(event) => setStatusMapping((current) => ({ ...current, [status.name]: event.target.value as KanbanColumnKey }))}
                      className="h-8 w-36 rounded-md border border-input bg-background px-2 text-sm"
                    >
                      {KANBAN_COLUMN_ORDER.map((key) => <option key={key} value={key}>{columnLabel(key)}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('kanban.connector.mappingHelp', { defaultValue: 'Test the connection to list your Jira statuses and choose their column. By default: To do → Backlog, In progress → In progress, Done → Done.' })}
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('kanban.connector.backToJira', { defaultValue: 'Back to Jira' })}
            </h3>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={pushStatus} onChange={(event) => setPushStatus(event.target.checked)} />
              <span>
                {t('kanban.connector.pushStatus', { defaultValue: 'Move the ticket when its card moves' })}
                <span className="block text-xs text-muted-foreground">
                  {t('kanban.connector.pushStatusHelp', { defaultValue: 'E.g. the agent finishes → the ticket goes to a "review/test" status.' })}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={postAgentComments} onChange={(event) => setPostAgentComments(event.target.checked)} />
              {t('kanban.connector.postComments', { defaultValue: 'Post the agent\'s summary as a ticket comment' })}
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
              {t('kanban.connector.enabled', { defaultValue: 'Sync automatically every 5 minutes' })}
            </label>
          </section>

          {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-5 py-3">
          {connector ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => void handleDelete()} disabled={busy !== null}>
              {busy === 'delete' ? <Loader2 className="animate-spin" /> : <Trash2 />} {t('kanban.connector.unlink', { defaultValue: 'Unlink' })}
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void handleSave(false)} disabled={!canSubmit || busy !== null}>
              {busy === 'save' && <Loader2 className="animate-spin" />}
              {t('kanban.save', { defaultValue: 'Save' })}
            </Button>
            <Button type="button" size="sm" onClick={() => void handleSave(true)} disabled={!canSubmit || busy !== null}>
              {busy === 'save-sync' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t('kanban.connector.saveAndSync', { defaultValue: 'Save and sync' })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
