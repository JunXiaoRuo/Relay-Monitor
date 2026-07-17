import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';

import ipaddr from 'ipaddr.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface OutboundUrlOptions {
  allowHttp?: boolean;
  allowQuery?: boolean;
  allowCrossOriginRedirects?: boolean;
  allowWebhookPrivateAddresses?: boolean;
  allowedCidrs?: readonly string[];
  resolver?: AddressResolver;
  maxLength?: number;
}

export interface ValidatedOutboundUrl {
  url: URL;
  hostname: string;
  addresses: readonly ResolvedAddress[];
  lookup: LookupFunction;
}

export class UnsafeUrlError extends Error {
  readonly code = 'UNSAFE_OUTBOUND_URL';

  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

const BLOCKED_HOST_SUFFIXES = [
  'localhost',
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.onion',
  '.test',
  '.invalid',
];

function hostnameWithoutBrackets(hostname: string): string {
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return unbracketed.replace(/\.$/, '').toLowerCase();
}

function parseAllowedCidrs(cidrs: readonly string[]): Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> {
  return cidrs.map((cidr) => {
    try {
      return ipaddr.parseCIDR(cidr);
    } catch {
      throw new TypeError(`Invalid allowed SSRF CIDR: ${cidr}`);
    }
  });
}

function normalizedAddress(address: string): ipaddr.IPv4 | ipaddr.IPv6 {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    throw new UnsafeUrlError('DNS returned an invalid IP address');
  }
  if (parsed.kind() === 'ipv6') {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) return ipv6.toIPv4Address();
  }
  return parsed;
}

export function isPublicAddress(address: string, allowedCidrs: readonly string[] = []): boolean {
  const parsed = normalizedAddress(address);
  if (isAddressInAllowedCidrs(address, allowedCidrs)) return true;
  return parsed.range() === 'unicast';
}

export function isAddressInAllowedCidrs(address: string, allowedCidrs: readonly string[]): boolean {
  const parsed = normalizedAddress(address);
  return parseAllowedCidrs(allowedCidrs).some(
    (cidr) => parsed.kind() === cidr[0].kind() && parsed.match(cidr),
  );
}

const WEBHOOK_DEFAULT_ADDRESS_RANGES = new Set(['unicast', 'private', 'loopback']);
const WEBHOOK_EXPLICIT_ADDRESS_RANGES = new Set(['unicast', 'carrierGradeNat', 'uniqueLocal']);

export function isWebhookPrivateOrLoopbackAddress(address: string): boolean {
  const range = normalizedAddress(address).range();
  return range === 'private' || range === 'loopback';
}

export function isWebhookAddressAllowed(
  address: string,
  allowedCidrs: readonly string[] = [],
): boolean {
  const range = normalizedAddress(address).range();
  if (WEBHOOK_DEFAULT_ADDRESS_RANGES.has(range)) return true;
  return WEBHOOK_EXPLICIT_ADDRESS_RANGES.has(range)
    && isAddressInAllowedCidrs(address, allowedCidrs);
}

export function isWebhookHttpAddressAllowed(
  address: string,
  allowedCidrs: readonly string[] = [],
): boolean {
  if (isWebhookPrivateOrLoopbackAddress(address)) return true;
  const range = normalizedAddress(address).range();
  return WEBHOOK_EXPLICIT_ADDRESS_RANGES.has(range)
    && isAddressInAllowedCidrs(address, allowedCidrs);
}

function parseAndValidateUrl(rawUrl: string, options: OutboundUrlOptions): URL {
  if (rawUrl.length > (options.maxLength ?? 2_048)) throw new UnsafeUrlError('Outbound URL is too long');

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('Outbound URL is invalid');
  }

  const allowedProtocols = options.allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!allowedProtocols.includes(url.protocol)) throw new UnsafeUrlError('Outbound URL must use HTTPS');
  if (url.username || url.password) throw new UnsafeUrlError('Outbound URL must not contain credentials');
  if (url.hash) throw new UnsafeUrlError('Outbound URL must not contain a fragment');
  if (!options.allowQuery && url.search) throw new UnsafeUrlError('Outbound URL must not contain a query string');

  const hostname = hostnameWithoutBrackets(url.hostname);
  if (!hostname || hostname.length > 253 || hostname.includes('%')) {
    throw new UnsafeUrlError('Outbound URL hostname is invalid');
  }
  const webhookLocalhost = options.allowWebhookPrivateAddresses
    && (hostname === 'localhost' || hostname.endsWith('.localhost'));
  if (
    !webhookLocalhost
    && BLOCKED_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(suffix))
  ) {
    throw new UnsafeUrlError('Local and special-use hostnames are blocked');
  }
  if (!webhookLocalhost && !ipaddr.isValid(hostname) && !hostname.includes('.')) {
    throw new UnsafeUrlError('Single-label hostnames are blocked');
  }

  if (url.hostname.endsWith('.')) url.hostname = hostname;
  return url;
}

const defaultResolver: AddressResolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => {
    if (answer.family !== 4 && answer.family !== 6) {
      throw new UnsafeUrlError('DNS returned an unsupported address family');
    }
    return { address: answer.address, family: answer.family };
  });
};

function createPinnedLookup(hostname: string, addresses: readonly ResolvedAddress[]): LookupFunction {
  return (requestedHostname, options: LookupOptions, callback) => {
    if (hostnameWithoutBrackets(requestedHostname) !== hostname) {
      const error = new Error('Pinned DNS lookup hostname mismatch') as NodeJS.ErrnoException;
      error.code = 'EHOSTUNREACH';
      callback(error, '');
      return;
    }

    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    const matching = addresses.filter((address) => family === 0 || address.family === family);
    if (matching.length === 0) {
      const error = new Error('No validated address matches the requested family') as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      callback(error, '');
      return;
    }

    if (options.all) {
      callback(null, matching.map((address) => ({ ...address })));
    } else {
      const selected = matching[0];
      if (!selected) {
        callback(new Error('No validated address available'), '');
        return;
      }
      callback(null, selected.address, selected.family);
    }
  };
}

export async function validateOutboundUrl(
  rawUrl: string,
  options: OutboundUrlOptions = {},
): Promise<ValidatedOutboundUrl> {
  const url = parseAndValidateUrl(rawUrl, options);
  const hostname = hostnameWithoutBrackets(url.hostname);
  const literalAddress = ipaddr.isValid(hostname)
    ? [{ address: normalizedAddress(hostname).toString(), family: normalizedAddress(hostname).kind() === 'ipv4' ? 4 : 6 } as const]
    : undefined;

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = literalAddress ?? (await (options.resolver ?? defaultResolver)(hostname));
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw error;
    throw new UnsafeUrlError('Outbound hostname could not be resolved');
  }

  if (addresses.length === 0) throw new UnsafeUrlError('Outbound hostname has no addresses');
  const unique = new Map<string, ResolvedAddress>();
  for (const answer of addresses) {
    const parsed = normalizedAddress(answer.address);
    const normalized = parsed.toString();
    const family = parsed.kind() === 'ipv4' ? 4 : 6;
    const addressAllowed = options.allowWebhookPrivateAddresses
      ? isWebhookAddressAllowed(normalized, options.allowedCidrs)
      : isPublicAddress(normalized, options.allowedCidrs);
    if (!addressAllowed) {
      throw new UnsafeUrlError('Outbound hostname resolves to a private or special-use address');
    }
    unique.set(`${family}:${normalized}`, { address: normalized, family });
  }

  const validatedAddresses = Object.freeze([...unique.values()].map((address) => Object.freeze(address)));
  return Object.freeze({
    url,
    hostname,
    addresses: validatedAddresses,
    lookup: createPinnedLookup(hostname, validatedAddresses),
  });
}

export async function validateRedirect(
  current: ValidatedOutboundUrl,
  location: string,
  options: OutboundUrlOptions = {},
): Promise<ValidatedOutboundUrl> {
  const target = new URL(location, current.url);
  if (!options.allowCrossOriginRedirects && target.origin !== current.url.origin) {
    throw new UnsafeUrlError('Cross-origin redirects are blocked');
  }
  return validateOutboundUrl(target.toString(), options);
}

export async function normalizeAndValidateBaseUrl(
  rawUrl: string,
  options: Omit<OutboundUrlOptions, 'allowQuery'> = {},
): Promise<ValidatedOutboundUrl> {
  const validated = await validateOutboundUrl(rawUrl, { ...options, allowQuery: false });
  validated.url.pathname = validated.url.pathname.replace(/\/+$/, '') || '/';
  return validated;
}
