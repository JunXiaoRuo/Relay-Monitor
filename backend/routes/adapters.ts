import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AdapterManifest, AdapterRegistry } from '../adapters/contracts/index.js';
import { success } from '../core/api-response.js';

function publicManifest(manifest: AdapterManifest) {
  return {
    contract_version: manifest.contractVersion,
    adapter_type: manifest.adapterType,
    adapter_version: manifest.adapterVersion,
    adapter_schema_version: manifest.adapterSchemaVersion,
    display_name: manifest.displayName,
    monitor_types: manifest.monitorTypes,
    credential_fields: manifest.credentialFields.map((field) => ({
      key: field.key,
      input: field.input,
      secret: field.secret,
      required: field.required ?? false,
      required_when: field.requiredWhen ?? [],
      persistable: field.persistable ?? true,
    })),
    capabilities: {
      supports_auth_refresh: manifest.capabilities.authRefresh,
      supports_balance: manifest.capabilities.balances,
      supports_rates: manifest.capabilities.rates,
      supports_channels: manifest.capabilities.channels,
      supports_active_probe: manifest.capabilities.activeProbe,
    },
  };
}

export async function registerAdapterRoutes(
  app: FastifyInstance,
  registry: AdapterRegistry,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/v1/adapters',
    {
      schema: {
        tags: ['adapters'],
        summary: '列出已安装的内置适配器',
      },
    },
    async (request) => success(request, registry.manifests().map(publicManifest)),
  );

  typed.get(
    '/api/v1/adapters/:adapter_type',
    {
      schema: {
        tags: ['adapters'],
        summary: '读取适配器 Manifest',
        params: z.object({
          adapter_type: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
        }),
      },
    },
    async (request) => success(request, publicManifest(registry.get(request.params.adapter_type).manifest())),
  );
}
