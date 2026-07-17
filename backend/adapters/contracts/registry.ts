import { AdapterError } from './errors.js';
import type { AdapterManifest, RelayAdapter } from './types.js';

export class AdapterRegistry {
  readonly #adapters = new Map<string, RelayAdapter>();

  constructor(adapters: readonly RelayAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: RelayAdapter): void {
    const manifest = adapter.manifest();
    if (this.#adapters.has(manifest.adapterType)) {
      throw new Error(`Adapter '${manifest.adapterType}' is already registered`);
    }
    this.#adapters.set(manifest.adapterType, adapter);
  }

  has(adapterType: string): boolean {
    return this.#adapters.has(adapterType);
  }

  get(adapterType: string): RelayAdapter {
    const adapter = this.#adapters.get(adapterType);
    if (!adapter) {
      throw new AdapterError('ADAPTER_UNAVAILABLE', `Adapter '${adapterType}' is not installed`);
    }
    return adapter;
  }

  manifests(): AdapterManifest[] {
    return [...this.#adapters.values()]
      .map((adapter) => adapter.manifest())
      .sort((left, right) => left.adapterType.localeCompare(right.adapterType));
  }
}
