import { OpenAICompatibleAdapter, type OpenAICompatibleConfig } from './adapter.js';
import { credentialIdFor } from '../credential-keys.js';
import { buildModels, type ProviderSeed } from '../catalog.js';

/**
 * Build the adapter for a catalogued provider.
 *
 * Each provider used to hand back its own `new OpenAICompatibleAdapter({...})` with the same
 * six lines of credential/header wiring; only the model list differed, and that list now
 * lives in `catalog.ts`. `extra` covers the handful of providers with behaviour beyond the
 * template (a preset accountId, a different baseUrl, additional headers).
 */
export function createStaticAdapter(
  seed: ProviderSeed,
  rawCredential?: string,
  extra?: Partial<OpenAICompatibleConfig>
): OpenAICompatibleAdapter {
  // A local server declares `authType: 'none'`; a stray value in the secret store must not
  // turn it into a credential-bearing provider (that changes both status and headers).
  const credential = seed.authType === 'none' ? undefined : rawCredential;

  const config: OpenAICompatibleConfig = {
    providerId: seed.id,
    providerName: seed.name,
    baseUrl: seed.baseUrl,
    authType: seed.authType ?? 'api-key',
    credentialId: credentialIdFor(seed.id, credential),
    defaultHeaders: credential
      ? { Authorization: `Bearer ${credential}`, ...seed.headers }
      : { ...seed.headers },
    models: buildModels(seed),
    ...(seed.configFields ? { configFields: seed.configFields } : {}),
    ...(seed.requiredSettings ? { requiredSettings: seed.requiredSettings } : {}),
    ...(seed.resolveBaseUrl ? { resolveBaseUrl: seed.resolveBaseUrl } : {}),
    ...extra,
  };

  return new OpenAICompatibleAdapter(config);
}
