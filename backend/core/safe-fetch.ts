import { Agent, fetch as undiciFetch } from 'undici';

import {
  normalizeAndValidateBaseUrl,
  type AddressResolver,
  type ValidatedOutboundUrl,
} from './ssrf.js';

export interface SafeFetchOptions {
  allowHttp?: boolean;
  allowWebhookPrivateAddresses?: boolean;
  allowedCidrs?: readonly string[];
  resolver?: AddressResolver;
  connectTimeoutMs?: number;
  maxResponseBytes?: number;
}

export interface SafeFetchContext {
  baseUrl: string;
  validated: ValidatedOutboundUrl;
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0], baseUrl: URL): URL {
  if (typeof input === 'string' || input instanceof URL) return new URL(input, baseUrl);
  return new URL(input.url, baseUrl);
}

export async function createSafeFetchContext(
  rawBaseUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchContext> {
  const validated = await normalizeAndValidateBaseUrl(rawBaseUrl, {
    ...(options.allowHttp === undefined ? {} : { allowHttp: options.allowHttp }),
    ...(options.allowWebhookPrivateAddresses === undefined
      ? {}
      : { allowWebhookPrivateAddresses: options.allowWebhookPrivateAddresses }),
    ...(options.allowedCidrs ? { allowedCidrs: options.allowedCidrs } : {}),
    ...(options.resolver ? { resolver: options.resolver } : {}),
  });
  const dispatcher = new Agent({
    connect: {
      lookup: validated.lookup,
      timeout: options.connectTimeoutMs ?? 10_000,
    },
    maxResponseSize: options.maxResponseBytes ?? 2 * 1024 * 1024,
    pipelining: 1,
  });

  const pinnedFetch: typeof globalThis.fetch = async (input, init) => {
    const target = requestUrl(input, validated.url);
    if (target.origin !== validated.url.origin) {
      throw new Error('Cross-origin upstream requests are blocked');
    }
    if (target.username || target.password) {
      throw new Error('Credentials in upstream URLs are blocked');
    }

    const response = await undiciFetch(target, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
      redirect: 'manual',
    });
    return response as unknown as Response;
  };

  return {
    baseUrl: validated.url.toString().replace(/\/$/, ''),
    validated,
    fetch: pinnedFetch,
    close: async () => dispatcher.close(),
  };
}
