import { AdapterRegistry } from './contracts/registry.js';
import { Sub2ApiAdapter } from './sub2api/adapter.js';

export * from './contracts/index.js';
export * from './sub2api/index.js';

export function createBuiltinAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry([new Sub2ApiAdapter()]);
}
