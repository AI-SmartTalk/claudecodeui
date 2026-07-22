import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import {
  DEFAULT_MODELS_CHANGED_EVENT,
  fetchDefaultModels,
  saveDefaultModel,
} from '../../../utils/defaultModels';
import type { DefaultModelMap } from '../../../utils/defaultModels';
import type { LLMProvider, ProviderModelsDefinition } from '../../../types/app';

const PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode'];

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: {
    models?: ProviderModelsDefinition;
  };
};

/**
 * Backs the "Default model" control in Settings → Agents → Account.
 *
 * Loads every provider's model catalog alongside the server-side defaults so
 * the select can render labels, and stays in sync with picks made elsewhere
 * (the `/model` modal) through DEFAULT_MODELS_CHANGED_EVENT.
 */
export function useDefaultModelSettings() {
  const [modelCatalog, setModelCatalog] = useState<Partial<Record<LLMProvider, ProviderModelsDefinition>>>({});
  const [defaultModels, setDefaultModels] = useState<DefaultModelMap>({});
  const [loading, setLoading] = useState(true);
  const [savingProvider, setSavingProvider] = useState<LLMProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [defaults, catalogEntries] = await Promise.all([
          fetchDefaultModels(),
          Promise.all(PROVIDERS.map(async (provider) => {
            const response = await authenticatedFetch(`/api/providers/${provider}/models`);
            const body = (await response.json()) as ProviderModelsApiResponse;
            return [provider, body.success ? body.data?.models : undefined] as const;
          })),
        ]);

        if (cancelled) {
          return;
        }

        setDefaultModels(defaults);
        setModelCatalog(Object.fromEntries(catalogEntries.filter(([, models]) => models)));
        setError(null);
      } catch (caughtError) {
        if (!cancelled) {
          setError(caughtError instanceof Error ? caughtError.message : 'Unable to load models.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleDefaultModelsChanged = (event: Event) => {
      const detail = (event as CustomEvent<DefaultModelMap>).detail;
      if (detail) {
        setDefaultModels(detail);
      }
    };

    window.addEventListener(DEFAULT_MODELS_CHANGED_EVENT, handleDefaultModelsChanged);
    return () => {
      window.removeEventListener(DEFAULT_MODELS_CHANGED_EVENT, handleDefaultModelsChanged);
    };
  }, []);

  const selectDefaultModel = useCallback(async (provider: LLMProvider, model: string) => {
    setSavingProvider(provider);
    try {
      // saveDefaultModel broadcasts, which feeds the listener above.
      setDefaultModels(await saveDefaultModel(provider, model));
      setError(null);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to save the default model.');
    } finally {
      setSavingProvider(null);
    }
  }, []);

  return {
    modelCatalog,
    defaultModels,
    loading,
    savingProvider,
    error,
    selectDefaultModel,
  };
}
