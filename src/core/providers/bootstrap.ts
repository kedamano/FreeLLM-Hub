import { getProviderRegistry } from './registry.js';
import {
  createOllamaAdapter,
  createLMStudioAdapter,
  createGroqAdapter,
  createGoogleGeminiAdapter,
  createCloudflareAdapter,
  createHuggingFaceAdapter,
  createCerebrasAdapter,
  createSiliconFlowAdapter,
  createNvidiaAdapter,
  createOpenRouterAdapter,
  createModelScopeAdapter,
  createSenseNovaAdapter,
} from './index.js';
import type { ProviderAdapter, ProviderRegistry } from './contracts.js';

interface ReadCredentialStore {
  retrieve(id: string): string | null;
}

interface HotSwapAdapter {
  setEnabled?(enabled: boolean): void;
  setCredential?(credential: string | undefined, credentialId?: string): void;
  updateBaseUrl?(baseUrl: string): void;
}

export function hotSwap(adapter: ProviderAdapter): HotSwapAdapter {
  return adapter as unknown as HotSwapAdapter;
}

export function applyEnabled(adapter: ProviderAdapter, enabled: boolean): void {
  const api = hotSwap(adapter);
  if (typeof api.setEnabled === 'function') {
    api.setEnabled(enabled);
    return;
  }
  adapter.getProviderConfig().isEnabled = enabled;
}

export function applyCredential(adapter: ProviderAdapter, credential: string | undefined, credentialId?: string): void {
  const api = hotSwap(adapter);
  if (typeof api.setCredential === 'function') api.setCredential(credential, credentialId);
}

export const ENABLED_KEY_PREFIX = 'provider-enabled:';

export function registerAllProviders(registry: ProviderRegistry, credentialStore: ReadCredentialStore): void {
  const ollamaKey = 'ollama-config';
  let ollamaBaseUrl = 'http://localhost:11434';
  const ollamaConfig = credentialStore.retrieve(ollamaKey);
  if (ollamaConfig) {
    try {
      const parsed = JSON.parse(ollamaConfig);
      if (parsed.baseUrl) ollamaBaseUrl = parsed.baseUrl;
    } catch {
      console.warn('[Bootstrap] Invalid ollama config in credential store');
    }
  }

  registry.register(createOllamaAdapter({ baseUrl: ollamaBaseUrl }));
  registry.register(createLMStudioAdapter());

  const groqKey = credentialStore.retrieve('groq-key');
  registry.register(createGroqAdapter(groqKey || undefined));

  const googleKey = credentialStore.retrieve('google-key');
  registry.register(createGoogleGeminiAdapter(googleKey || undefined));

  const cfToken = credentialStore.retrieve('cloudflare-token');
  const cfAccount = credentialStore.retrieve('cloudflare-account');
  registry.register(createCloudflareAdapter(cfAccount || undefined, cfToken || undefined));

  const hfToken = credentialStore.retrieve('huggingface-token');
  registry.register(createHuggingFaceAdapter(hfToken || undefined));

  const cerebrasKey = credentialStore.retrieve('cerebras-key');
  registry.register(createCerebrasAdapter(cerebrasKey || undefined));

  const siliconflowKey = credentialStore.retrieve('siliconflow-key');
  registry.register(createSiliconFlowAdapter(siliconflowKey || undefined));

  const nvidiaKey = credentialStore.retrieve('nvidia-key');
  registry.register(createNvidiaAdapter(nvidiaKey || undefined));

  const openrouterKey = credentialStore.retrieve('openrouter-key');
  registry.register(createOpenRouterAdapter(openrouterKey || undefined));

  const modelscopeKey = credentialStore.retrieve('modelscope-key');
  registry.register(createModelScopeAdapter(modelscopeKey || undefined));

  const sensenovaKey = credentialStore.retrieve('sensenova-key');
  registry.register(createSenseNovaAdapter(sensenovaKey || undefined));

  console.log(`[Providers] Registered ${registry.getAll().length} providers`);
}

export function applyPersistedProviderEnabledFromSettings(
  readSetting: (key: string) => string | null,
  registry: ProviderRegistry = getProviderRegistry()
): void {
  for (const adapter of registry.getAll()) {
    const stored = readSetting(`${ENABLED_KEY_PREFIX}${adapter.providerId}`);
    if (stored === null) continue;
    applyEnabled(adapter, stored !== 'false');
  }
}
