import { useEffect, useState } from 'react';

import { api, fetchDefaultModels } from '@/shared/api';
import type { DefaultModelMap, LLMProvider, ProviderModelOption } from '@/shared/types';

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: { models?: { OPTIONS?: ProviderModelOption[] } };
};

/**
 * The model menu for a card: the provider's catalog plus the app-wide default
 * (Settings › default model) that a card without its own choice runs on —
 * the same resolution the chat composer uses for a new conversation.
 */
export function useKanbanModels(provider: LLMProvider) {
  // The selectable models of the card's provider, empty until loaded.
  const [options, setOptions] = useState<ProviderModelOption[]>([]);
  // The app-wide default per provider, shown as "Default (…)" in the menu.
  const [defaults, setDefaults] = useState<DefaultModelMap>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [defaultModels, response] = await Promise.all([
          fetchDefaultModels(),
          api.providers.models(provider),
        ]);
        const body = (await response.json()) as ProviderModelsApiResponse;
        if (!cancelled) {
          setDefaults(defaultModels);
          setOptions(body.success ? body.data?.models?.OPTIONS ?? [] : []);
        }
      } catch {
        // The menu still offers "Default"; the server resolves it at run time.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const defaultModel = defaults[provider] ?? null;
  const defaultLabel = options.find((option) => option.value === defaultModel)?.label ?? defaultModel;
  return { options, defaultModel, defaultLabel };
}
