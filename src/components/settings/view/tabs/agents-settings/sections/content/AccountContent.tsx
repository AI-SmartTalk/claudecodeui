import { BadgeCheck, Loader2, LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge, Button } from '../../../../../../../shared/view/ui';
import SessionProviderLogo from '../../../../../../llm-logo-provider/SessionProviderLogo';
import type { ProviderModelOption } from '../../../../../../../types/app';
import type { AgentProvider, AuthStatus } from '../../../../../types/types';

type AccountContentProps = {
  agent: AgentProvider;
  authStatus: AuthStatus;
  onLogin: () => void;
  defaultModel?: string;
  modelOptions: ProviderModelOption[];
  onSelectDefaultModel: (model: string) => void;
  defaultModelLoading: boolean;
  savingDefaultModel: boolean;
  defaultModelError: string | null;
};

type AgentVisualConfig = {
  name: string;
  bgClass: string;
  borderClass: string;
  textClass: string;
  subtextClass: string;
  buttonClass: string;
  description?: string;
};

const agentConfig: Record<AgentProvider, AgentVisualConfig> = {
  claude: {
    name: 'Claude',
    bgClass: 'bg-blue-50 dark:bg-blue-900/20',
    borderClass: 'border-blue-200 dark:border-blue-800',
    textClass: 'text-blue-900 dark:text-blue-100',
    subtextClass: 'text-blue-700 dark:text-blue-300',
    buttonClass: 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800',
  },
  cursor: {
    name: 'Cursor',
    bgClass: 'bg-purple-50 dark:bg-purple-900/20',
    borderClass: 'border-purple-200 dark:border-purple-800',
    textClass: 'text-purple-900 dark:text-purple-100',
    subtextClass: 'text-purple-700 dark:text-purple-300',
    buttonClass: 'bg-purple-600 hover:bg-purple-700 active:bg-purple-800',
  },
  codex: {
    name: 'Codex',
    bgClass: 'bg-muted/50',
    borderClass: 'border-gray-300 dark:border-gray-600',
    textClass: 'text-gray-900 dark:text-gray-100',
    subtextClass: 'text-gray-700 dark:text-gray-300',
    buttonClass: 'bg-gray-800 hover:bg-gray-900 active:bg-gray-950 dark:bg-gray-700 dark:hover:bg-gray-600 dark:active:bg-gray-500',
  },
  opencode: {
    name: 'OpenCode',
    description: 'OpenCode CLI assistant',
    bgClass: 'bg-zinc-50 dark:bg-zinc-900/20',
    borderClass: 'border-zinc-200 dark:border-zinc-700',
    textClass: 'text-zinc-900 dark:text-zinc-100',
    subtextClass: 'text-zinc-700 dark:text-zinc-300',
    buttonClass: 'bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-950 dark:bg-zinc-700 dark:hover:bg-zinc-600',
  },
};

export default function AccountContent({
  agent,
  authStatus,
  onLogin,
  defaultModel,
  modelOptions,
  onSelectDefaultModel,
  defaultModelLoading,
  savingDefaultModel,
  defaultModelError,
}: AccountContentProps) {
  const { t } = useTranslation('settings');
  const config = agentConfig[agent];

  return (
    <div className="space-y-6">
      <div className="mb-4 flex items-center gap-3">
        <SessionProviderLogo provider={agent} className="h-6 w-6" />
        <div>
          <h3 className="text-lg font-medium text-foreground">{config.name}</h3>
          <p className="text-sm text-muted-foreground">
            {t(`agents.account.${agent}.description`, {
              defaultValue: config.description || `${config.name} CLI assistant`,
            })}
          </p>
        </div>
      </div>

      <div className={`${config.bgClass} border ${config.borderClass} rounded-lg p-4`}>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className={`font-medium ${config.textClass}`}>
                {t('agents.connectionStatus')}
              </div>
              <div className={`text-sm ${config.subtextClass}`}>
                {authStatus.loading ? (
                  t('agents.authStatus.checkingAuth')
                ) : authStatus.authenticated ? (
                  t('agents.authStatus.loggedInAs', {
                    email: authStatus.email || t('agents.authStatus.authenticatedUser'),
                  })
                ) : (
                  t('agents.authStatus.notConnected')
                )}
              </div>
            </div>
            <div>
              {authStatus.loading ? (
                <Badge variant="secondary" className="bg-muted">
                  {t('agents.authStatus.checking')}
                </Badge>
              ) : authStatus.authenticated ? (
                <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                  {t('agents.authStatus.connected')}
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300">
                  {t('agents.authStatus.disconnected')}
                </Badge>
              )}
            </div>
          </div>

          {authStatus.method !== 'api_key' && (
            <div className="border-t border-border/50 pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className={`font-medium ${config.textClass}`}>
                    {authStatus.authenticated ? t('agents.login.reAuthenticate') : t('agents.login.title')}
                  </div>
                  <div className={`text-sm ${config.subtextClass}`}>
                    {authStatus.authenticated
                      ? t('agents.login.reAuthDescription')
                      : t('agents.login.description', { agent: config.name })}
                  </div>
                </div>
                <Button
                  onClick={onLogin}
                  className={`${config.buttonClass} text-white`}
                  size="sm"
                >
                  <LogIn className="mr-2 h-4 w-4" />
                  {authStatus.authenticated ? t('agents.login.reLoginButton') : t('agents.login.button')}
                </Button>
              </div>
            </div>
          )}

          {authStatus.error && (
            <div className="border-t border-border/50 pt-4">
              <div className="text-sm text-red-600 dark:text-red-400">
                {t('agents.error', { error: authStatus.error })}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <h4 className="font-medium text-foreground">
            {t('agents.defaultModel.title', { defaultValue: 'Default model' })}
          </h4>
          <p className="text-sm text-muted-foreground">
            {t('agents.defaultModel.description', {
              agent: config.name,
              defaultValue: `Model new ${config.name} conversations start on. Inside a conversation, /model still overrides it for that session only.`,
            })}
          </p>
        </div>

        {defaultModelLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('agents.defaultModel.loading', { defaultValue: 'Loading models...' })}
          </div>
        ) : modelOptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('agents.defaultModel.unavailable', { defaultValue: 'No models available for this agent.' })}
          </p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {modelOptions.map((option) => {
              const isSelected = option.value === defaultModel;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onSelectDefaultModel(option.value)}
                  disabled={savingDefaultModel}
                  aria-pressed={isSelected}
                  className={`flex flex-col rounded-lg border p-3 text-left transition-all disabled:opacity-60 ${
                    isSelected
                      ? 'border-primary/50 bg-primary/10'
                      : 'border-border bg-card/50 hover:border-primary/30 hover:bg-accent/50'
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground">{option.label}</span>
                    {isSelected && <BadgeCheck className="h-4 w-4 shrink-0 text-primary" />}
                  </span>
                  <span className="mt-0.5 font-mono text-xs text-muted-foreground">{option.value}</span>
                  {option.description && (
                    <span className="mt-1 text-xs text-muted-foreground">{option.description}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {defaultModelError && (
          <p className="text-sm text-red-600 dark:text-red-400">{defaultModelError}</p>
        )}
      </div>
    </div>
  );
}
