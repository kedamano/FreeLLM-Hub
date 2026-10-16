import type {
  ProviderAdapter,
  ProviderRegistry,
} from './contracts.js';

class ProviderRegistryImpl implements ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.providerId)) {
      console.warn(`Provider ${adapter.providerId} already registered, replacing`);
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

  async getAvailable(): Promise<ProviderAdapter[]> {
    const results = await Promise.allSettled(
      this.getAll().map(async (adapter) => {
        const available = await adapter.isAvailable();
        return available ? adapter : null;
      })
    );

    return results
      .filter(
        (r): r is PromiseFulfilledResult<ProviderAdapter | null> =>
          r.status === 'fulfilled' && r.value !== null
      )
      .map((r) => r.value!);
  }
}

let instance: ProviderRegistryImpl | null = null;

export function getProviderRegistry(): ProviderRegistryImpl {
  if (!instance) {
    instance = new ProviderRegistryImpl();
  }
  return instance;
}
