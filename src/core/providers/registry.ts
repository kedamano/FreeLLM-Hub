import type {
  ProviderAdapter,
  ProviderRegistry,
} from './contracts.js';
import { loggerFor } from '../log/logger.js';

const log = loggerFor('providers');

class ProviderRegistryImpl implements ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.providerId)) {
      log.warn({ providerId: adapter.providerId }, 'provider already registered, replacing');
    }
    this.adapters.set(adapter.providerId, adapter);
  }

  unregister(providerId: string): void {
    this.adapters.delete(providerId);
  }

  get(providerId: string): ProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  getAll(): ProviderAdapter[] {
    return Array.from(this.adapters.values());
  }
}

let instance: ProviderRegistryImpl | null = null;

export function getProviderRegistry(): ProviderRegistryImpl {
  if (!instance) {
    instance = new ProviderRegistryImpl();
  }
  return instance;
}
