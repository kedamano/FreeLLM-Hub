import { getProviderRegistry } from './registry.js';
import { OpenAICompatibleAdapter } from './openai-compatible/adapter.js';
import { getDatabase } from '../database/database.js';
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
  createLongCatAdapter,
  createZhipuAdapter,
  createMoonshotAdapter,
  createDeepSeekAdapter,
  createMiniMaxAdapter,
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

  const longcatKey = credentialStore.retrieve('longcat-key');
  registry.register(createLongCatAdapter(longcatKey || undefined));

  const zhipuKey = credentialStore.retrieve('zhipu-key');
  registry.register(createZhipuAdapter(zhipuKey || undefined));

  const moonshotKey = credentialStore.retrieve('moonshot-key');
  registry.register(createMoonshotAdapter(moonshotKey || undefined));

  const deepseekKey = credentialStore.retrieve('deepseek-key');
  registry.register(createDeepSeekAdapter(deepseekKey || undefined));

  const minimaxKey = credentialStore.retrieve('minimax-key');
  registry.register(createMiniMaxAdapter(minimaxKey || undefined));

  registerCustomProvidersFromDb(registry, credentialStore);

  console.log(`[Providers] Registered ${registry.getAll().length} providers`);
}

export const CUSTOM_PROVIDER_PREFIX = 'custom-';

export function makeCustomProviderId(name: string, existing: Set<string>): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = `${CUSTOM_PROVIDER_PREFIX}${slug || 'provider'}`;
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function registerCustomProvidersFromDb(
  registry: ProviderRegistry,
  credentialStore: ReadCredentialStore
): void {
  try {
    const rows = getDatabase()
      .prepare('SELECT id, display_name, base_url, is_enabled FROM providers WHERE is_built_in = 0')
      .all() as Array<{ id: string; display_name: string; base_url: string; is_enabled: number }>;
    for (const row of rows) {
      if (registry.get(row.id)) continue;
      const credential = credentialStore.retrieve(`${row.id}-key`);
      const adapter = new OpenAICompatibleAdapter({
        providerId: row.id,
        providerName: row.display_name,
        baseUrl: row.base_url,
        authType: 'api-key',
        isBuiltIn: false,
        credentialId: credential ? `${row.id}-key` : undefined,
        defaultHeaders: credential ? { Authorization: `Bearer ${credential}` } : {},
      });
      adapter.setEnabled(row.is_enabled === 1);
      registry.register(adapter);
    }
  } catch (err) {
    console.warn('[Bootstrap] Failed to load custom providers:', err);
  }
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
