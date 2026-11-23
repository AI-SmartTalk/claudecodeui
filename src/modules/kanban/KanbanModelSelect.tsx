import { useTranslation } from 'react-i18next';

import type { LLMProvider } from '@/shared/types';
import { useKanbanModels } from '@/modules/kanban/hooks/useKanbanModels';

type KanbanModelSelectProps = {
  provider: LLMProvider;
  /** null = the app's default model for the provider. */
  value: string | null;
  onChange: (model: string | null) => void;
  className?: string;
};

/**
 * The model menu used by the card and planning dialogs: "Default · …" (the
 * model chosen in Settings) plus the provider's catalog.
 */
export default function KanbanModelSelect({ provider, value, onChange, className }: KanbanModelSelectProps) {
  const { t } = useTranslation();
  const { options, defaultLabel } = useKanbanModels(provider);
  return (
    <select value={value ?? ''} onChange={(event) => onChange(event.target.value || null)} className={className}>
      <option value="">
        {defaultLabel && !/^default/i.test(defaultLabel)
          ? `${t('kanban.model.default', { defaultValue: 'Default' })} · ${defaultLabel}`
          : t('kanban.model.default', { defaultValue: 'Default' })}
      </option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
      {value && !options.some((option) => option.value === value) && <option value={value}>{value}</option>}
    </select>
  );
}
