import { describe, expect, it } from 'vitest';
import { FormData as UndiciFormData } from 'undici';

import {
  buildWebhookHeaders,
  buildWebhookRequestBody,
  createWebhookFetchContext,
  serializeWebhookPayload,
  signWebhook,
  verifyWebhookSignature,
} from '../../backend/core/webhook.js';

const timestamp = '1720951200';
const body = '{"schema_version":"1.0","event_id":"evt_01","amount":"0.120"}';

describe('webhook signatures', () => {
  it('matches the fixed HMAC-SHA256 vector over timestamp dot raw-body bytes', () => {
    expect(signWebhook('test-secret', timestamp, body)).toBe(
      'sha256=fed8c277181165bc00abba534a3da73454c4b2ee5565adcf5648187f41a9d671',
    );
  });

  it('verifies current and previous keys during rotation', () => {
    const previousSignature = signWebhook('previous-secret', timestamp, body);
    expect(
      verifyWebhookSignature(previousSignature, timestamp, body, {
        current: 'current-secret',
        previous: 'previous-secret',
      }, { now: Number(timestamp) * 1_000 }),
    ).toEqual({ valid: true, keyVersion: 'previous', timestamp: Number(timestamp) });

    const currentSignature = signWebhook('current-secret', timestamp, body);
    expect(
      verifyWebhookSignature(currentSignature, timestamp, body, {
        current: 'current-secret',
        previous: 'previous-secret',
      }, { now: Number(timestamp) * 1_000 }),
    ).toMatchObject({ valid: true, keyVersion: 'current' });
  });

  it('rejects stale timestamps, malformed signatures, and a changed raw body', () => {
    const signature = signWebhook('test-secret', timestamp, body);
    expect(
      verifyWebhookSignature(signature, timestamp, body, { current: 'test-secret' }, {
        now: (Number(timestamp) + 301) * 1_000,
      }),
    ).toEqual({ valid: false, reason: 'expired' });
    expect(
      verifyWebhookSignature('bad', timestamp, body, { current: 'test-secret' }, {
        now: Number(timestamp) * 1_000,
      }),
    ).toEqual({ valid: false, reason: 'invalid_signature' });
    expect(
      verifyWebhookSignature(signature, timestamp, `${body}\n`, { current: 'test-secret' }, {
        now: Number(timestamp) * 1_000,
      }),
    ).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('builds idempotent headers and prevents custom headers from overriding signature semantics', () => {
    const rawBody = serializeWebhookPayload({ schema_version: '1.0', amount: '0.12' });
    const headers = buildWebhookHeaders({
      eventId: 'evt_01',
      timestamp,
      rawBody,
      secret: 'test-secret',
      customHeaders: { 'X-Tenant': 'relay', 'Idempotency-Key': 'attacker-value' },
    });
    expect(headers['Idempotency-Key']).toBe('evt_01');
    expect(headers['X-Monitor-Event-ID']).toBe('evt_01');
    expect(headers['X-Tenant']).toBe('relay');
    expect(headers['X-Monitor-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe('webhook URL policy', () => {
  const publicResolver = async () => [{ address: '8.8.8.8', family: 4 as const }];
  const privateResolver = async () => [{ address: '10.20.30.40', family: 4 as const }];
  const loopbackResolver = async () => [{ address: '127.0.0.1', family: 4 as const }];
  const options = {
    allowedCidrs: [] as string[],
    connectTimeoutMs: 1_000,
    maxResponseBytes: 65_536,
  };

  it('allows HTTP during development while retaining address validation', async () => {
    const outbound = await createWebhookFetchContext('http://hooks.example.com/events', {
      ...options,
      isProduction: false,
      resolver: publicResolver,
    });
    expect(outbound.validated.url.protocol).toBe('http:');
    await outbound.close();
  });

  it('rejects public HTTP in production even when an unrelated CIDR is configured', async () => {
    await expect(createWebhookFetchContext('http://hooks.example.com/events', {
      ...options,
      isProduction: true,
      resolver: publicResolver,
    })).rejects.toThrow(/local or explicitly allowed/i);

    await expect(createWebhookFetchContext('http://hooks.example.com/events', {
      ...options,
      isProduction: true,
      allowedCidrs: ['10.0.0.0/8'],
      resolver: publicResolver,
    })).rejects.toThrow(/local or explicitly allowed/i);
  });

  it('allows RFC1918 and loopback HTTP in production without a CIDR allowlist', async () => {
    const privateOutbound = await createWebhookFetchContext('http://hooks.example.com/events', {
      ...options,
      isProduction: true,
      resolver: privateResolver,
    });
    expect(privateOutbound.validated.addresses).toEqual([{ address: '10.20.30.40', family: 4 }]);
    await privateOutbound.close();

    const loopbackOutbound = await createWebhookFetchContext('http://localhost/events', {
      ...options,
      isProduction: true,
      resolver: loopbackResolver,
    });
    expect(loopbackOutbound.validated.addresses).toEqual([{ address: '127.0.0.1', family: 4 }]);
    await loopbackOutbound.close();
  });

  it.each([
    ['link-local cloud metadata', '169.254.169.254', '169.254.0.0/16'],
    ['multicast', '224.0.0.1', '224.0.0.0/4'],
    ['reserved', '240.0.0.1', '240.0.0.0/4'],
    ['unspecified', '0.0.0.0', '0.0.0.0/8'],
  ])('blocks %s even when a global CIDR contains it', async (_label, address, cidr) => {
    await expect(createWebhookFetchContext('http://blocked.example.com/events', {
      ...options,
      isProduction: false,
      allowedCidrs: [cidr],
      resolver: async () => [{ address, family: 4 as const }],
    })).rejects.toThrow(/private or special-use/i);
  });
});

describe('webhook request bodies', () => {
  const payload = {
    schema_version: '1.0',
    event_id: 'event_body_test',
    event: 'site.timeout',
    incident: { summary: '站点 "Harbor"\n请求超时' },
    site: { name: 'Harbor' },
  };
  const payloadJson = JSON.stringify(payload);

  it('adds branded compatibility fields while keeping the canonical JSON event', async () => {
    const request = await buildWebhookRequestBody({ payloadJson, mode: 'json' });
    expect(request.contentType).toBe('application/json; charset=utf-8');
    expect(Buffer.isBuffer(request.body)).toBe(true);
    expect(JSON.parse((request.body as Buffer).toString('utf8'))).toEqual({
      ...payload,
      msg: payload.incident.summary,
      monitor: { name: 'Relay Monitor' },
      heartbeat: null,
    });
  });

  it('uses one data field and lets FormData generate the multipart boundary', async () => {
    const request = await buildWebhookRequestBody({ payloadJson, mode: 'form_data' });
    expect(request.contentType).toBeNull();
    expect(request.signingBody).toBeNull();
    expect(request.body).toBeInstanceOf(UndiciFormData);
    expect(JSON.parse(String((request.body as UndiciFormData).get('data')))).toEqual({
      ...payload,
      msg: payload.incident.summary,
      monitor: { name: 'Relay Monitor' },
      heartbeat: null,
    });
  });

  it('preserves compatibility fields explicitly supplied by the caller', async () => {
    const request = await buildWebhookRequestBody({
      payloadJson: JSON.stringify({
        ...payload,
        msg: '调用方消息',
        monitor: { name: '自定义来源' },
        heartbeat: { status: 1 },
      }),
      mode: 'json',
    });
    expect(JSON.parse((request.body as Buffer).toString('utf8'))).toMatchObject({
      msg: '调用方消息',
      monitor: { name: '自定义来源' },
      heartbeat: { status: 1 },
    });
  });

  it('renders custom JSON with safe JSON escaping and detects its content type', async () => {
    const request = await buildWebhookRequestBody({
      payloadJson,
      mode: 'custom',
      template: '{"summary": {{ payload.incident.summary | json }}, "msg": {{ msg | json }}, "nested_msg": {{ payload.msg | json }}, "source": {{ payload.monitor.name | json }}, "site": {{ payload.site.name | json }}}',
    });
    expect(request.contentType).toBe('application/json; charset=utf-8');
    expect(JSON.parse((request.body as Buffer).toString('utf8'))).toEqual({
      summary: payload.incident.summary,
      msg: payload.incident.summary,
      nested_msg: payload.incident.summary,
      source: 'Relay Monitor',
      site: 'Harbor',
    });
  });

  it('supports plain custom text but rejects Liquid control tags', async () => {
    const request = await buildWebhookRequestBody({
      payloadJson,
      mode: 'custom',
      template: 'Site: {{ payload.site.name }}',
    });
    expect(request.contentType).toBe('text/plain; charset=utf-8');
    expect((request.body as Buffer).toString('utf8')).toBe('Site: Harbor');
    await expect(buildWebhookRequestBody({
      payloadJson,
      mode: 'custom',
      template: '{% for item in payload %}{{ item }}{% endfor %}',
    })).rejects.toThrow(/不允许使用控制标签/);
  });
});
