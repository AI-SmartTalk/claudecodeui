/**
 * Per-provider default model — the model new conversations start on.
 *
 * The server (`app_config.provider_default_models`) is the source of truth so
 * the choice survives a browser change; `<provider>-model` in localStorage is
 * only a cache that lets the composer paint before the fetch resolves.
 *
 * Settings and the chat composer both mutate this value, so writers broadcast
 * `DEFAULT_MODELS_CHANGED_EVENT` and readers stay in sync without a shared
 * React tree.
 */

import type { LLMProvider } from '../types/app';

import { authenticatedFetch } from './api';

export type DefaultModelMap = Partial<Record<LLMProvider, string>>;

export const DEFAULT_MODELS_CHANGED_EVENT = 'cloudcli:default-models-changed';

type DefaultModelsApiResponse = {
  success?: boolean;
  data?: {
    models?: DefaultModelMap;
  };
};

export const modelStorageKey = (provider: LLMProvider): string => `${provider}-model`;

const readModelMap = (payload: unknown): DefaultModelMap => {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== ''),
  ) as DefaultModelMap;
};

/** Mirrors the server-side defaults into localStorage so the next paint is correct. */
export const cacheDefaultModels = (models: DefaultModelMap): void => {
  for (const [provider, model] of Object.entries(models)) {
    if (model) {
      localStorage.setItem(modelStorageKey(provider as LLMProvider), model);
    }
  }
};

export const broadcastDefaultModels = (models: DefaultModelMap): void => {
  window.dispatchEvent(new CustomEvent<DefaultModelMap>(DEFAULT_MODELS_CHANGED_EVENT, { detail: models }));
};

export const fetchDefaultModels = async (): Promise<DefaultModelMap> => {
  const response = await authenticatedFetch('/api/providers/default-models');
  const body = (await response.json()) as DefaultModelsApiResponse;
  if (!response.ok || !body.success) {
    throw new Error('Unable to load the default models.');
  }

  return readModelMap(body.data?.models);
};

/**
 * Persists the provider default server-side, then mirrors and announces it so
 * every open view (Settings, composer, `/model` modal) converges immediately.
 */
export const saveDefaultModel = async (
  provider: LLMProvider,
  model: string,
): Promise<DefaultModelMap> => {
  const response = await authenticatedFetch(`/api/providers/${provider}/default-model`, {
    method: 'PUT',
    body: JSON.stringify({ model }),
  });

  const body = (await response.json()) as DefaultModelsApiResponse;
  if (!response.ok || !body.success) {
    throw new Error('Unable to save the default model.');
  }

  const models = readModelMap(body.data?.models);
  cacheDefaultModels(models);
  broadcastDefaultModels(models);
  return models;
};
