/**
 * Provider registry bootstrap.
 *
 * Replaces the old hand-written list of `credentialStore.retrieve('<ad-hoc name>')`
 * calls: every provider now resolves its credential through the canonical
 * `credentialKeyFor(providerId)` id (migrating legacy ids on the way) and then has its
 * persisted base URL / settings / enabled flag applied, so what the UI saves is exactly
 * what the next launch loads.
 */

import type { ProviderAdapter } from './contracts.js';
import type { ProviderRegistry } from './contracts.js';
import { resolveProviderCredential, type SecretKeyStore } from './credential-keys.js';
import {
  applyProviderOverrides,
  migrateLegacyProviderFields,
  type PlainKeyStore,
} from './provider-state.js';

import { createOllamaAdapter } from './local/ollama-adapter.js';
import { createLMStudioAdapter } from './local/lmstudio-adapter.js';
import { createGroqAdapter } from './groq/adapter.js';
import { createGoogleGeminiAdapter } from './google-gemini/adapter.js';
import { createCloudflareAdapter } from './cloudflare/adapter.js';
import { createHuggingFaceAdapter } from './huggingface/adapter.js';
import { createCerebrasAdapter } from './cerebras/adapter.js';
import { createSiliconFlowAdapter } from './siliconflow/adapter.js';
import { createNvidiaAdapter } from './nvidia/adapter.js';
import { createOpenRouterAdapter } from './openrouter/adapter.js';
import { createModelScopeAdapter } from './modelscope/adapter.js';
import { createSenseNovaAdapter } from './sensenova/adapter.js';

export interface ProviderFactoryArgs {
  credential?: string;
}

export type ProviderFactory = (args: ProviderFactoryArgs) => ProviderAdapter;

/** Registration order doubles as the default scheduling preference for local-first use. */
export const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  ollama: () => createOllamaAdapter(),
  lmstudio: () => createLMStudioAdapter(),
  groq: ({ credential }) => createGroqAdapter(credential),
  'google-gemini': ({ credential }) => createGoogleGeminiAdapter(credential),
  cloudflare: ({ credential }) => createCloudflareAdapter(undefined, credential),
  huggingface: ({ credential }) => createHuggingFaceAdapter(credential),
  cerebras: ({ credential }) => createCerebrasAdapter(credential),
  siliconflow: ({ credential }) => createSiliconFlowAdapter(credential),
  nvidia: ({ credential }) => createNvidiaAdapter(credential),
  openrouter: ({ credential }) => createOpenRouterAdapter(credential),
  modelscope: ({ credential }) => createModelScopeAdapter(credential),
  sensenova: ({ credential }) => createSenseNovaAdapter(credential),
};

export function providerIds(): string[] {
  return Object.keys(PROVIDER_FACTORIES);
}

export interface ProviderBootstrapReport {
  registered: string[];
  withCredential: string[];
  migratedFields: string[];
  appliedOverrides: string[];
  errors: string[];
}

export interface BootstrapDeps {
  secrets: SecretKeyStore;
  settings: PlainKeyStore;
}

/**
 * Build every built-in adapter, wire credentials and persisted configuration, and
 * register them. A provider whose credential lookup fails still registers (so the UI
 * can show it and accept a key) — it is simply reported as not ready by its adapter.
 */
export function bootstrapProviders(
  registry: ProviderRegistry,
  deps: BootstrapDeps
): ProviderBootstrapReport {
  const report: ProviderBootstrapReport = {
    registered: [],
    withCredential: [],
    migratedFields: [],
    appliedOverrides: [],
    errors: [],
  };

  const adapters: ProviderAdapter[] = [];

  for (const [providerId, factory] of Object.entries(PROVIDER_FACTORIES)) {
    let credential: string | undefined;
    try {
      credential = resolveProviderCredential(deps.secrets, providerId).credential ?? undefined;
    } catch (err) {
      report.errors.push(
        `${providerId}: 读取凭证失败 (${err instanceof Error ? err.message : String(err)})`
      );
    }

    let adapter: ProviderAdapter;
    try {
      adapter = factory({ credential });
    } catch (err) {
      report.errors.push(
        `${providerId}: 初始化失败 (${err instanceof Error ? err.message : String(err)})`
      );
      continue;
    }

    adapters.push(adapter);
    registry.register(adapter);
    report.registered.push(providerId);
    if (credential) report.withCredential.push(providerId);
  }

  report.migratedFields = migrateLegacyProviderFields(
    deps.secrets,
    deps.settings,
    providerIds()
  );

  const { applied, errors } = applyProviderOverrides(adapters, deps.settings);
  report.appliedOverrides = applied;
  report.errors.push(...errors);

  return report;
}
