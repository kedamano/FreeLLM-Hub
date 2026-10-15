import type { ProviderAdapter, ProviderModel } from './contracts.js';
import { getProviderRegistry } from './registry.js';
import type { ProviderConfig } from '../../shared/types/index.js';

export interface DiscoveryResult {
  providerId: string;
  providerName: string;
  modelsFound: number;
  errors: string[];
  durationMs: number;
}

export async function discoverAllProviders(): Promise<ProviderModel[]> {
  const registry = getProviderRegistry();
  const adapters = registry.getAll();
  const allModels: ProviderModel[] = [];

  await Promise.allSettled(
    adapters.map(async (adapter) => {
      try {
        const models = await adapter.listModels();
        allModels.push(...models);
      } catch (err) {
        console.error(`Failed to discover models for ${adapter.providerId}:`, err);
      }
    })
  );

  return allModels;
}

export async function discoverProvider(adapter: ProviderAdapter): Promise<DiscoveryResult> {
  const start = Date.now();
  const errors: string[] = [];
  let modelsFound = 0;

  try {
    const models = await adapter.listModels();
    modelsFound = models.length;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return {
    providerId: adapter.providerId,
    providerName: adapter.providerName,
    modelsFound,
    errors,
    durationMs: Date.now() - start,
  };
}

export async function testProviderConnection(
  adapter: ProviderAdapter,
  credential?: string
): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const result = await adapter.validateCredential(credential);
    return {
      success: result.valid,
      latencyMs: Date.now() - start,
      error: result.reason,
    };
  } catch (err) {
    return {
      success: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
