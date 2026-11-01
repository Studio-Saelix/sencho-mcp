import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SenchoClient } from '../src/client.js';
import type { Config } from '../src/config.js';

const TOKEN = `sen_sk_${'A'.repeat(49)}`;

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

const servers: Server[] = [];

async function listen(handler: Handler): Promise<{ server: Server; baseUrl: URL; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => handler(req, res, body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: new URL(`http://127.0.0.1:${port}`), requests };
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** /api/meta advertises observation; every other path is the test's handler. */
function withMeta(handler: Handler): Handler {
  return (req, res, body) => {
    if (req.url === '/api/meta') {
      json(res, 200, { version: '0.99.0', capabilities: ['agent-observation-v1'] });
      return;
    }
    handler(req, res, body);
  };
}

function client(baseUrl: URL, overrides: Partial<Config> & { sleep?: (ms: number) => Promise<void> } = {}): SenchoClient {
  return new SenchoClient(
    { baseUrl, token: TOKEN, timeoutMs: 2_000, ...overrides },
    overrides.sleep ? { sleep: overrides.sleep } : {},
  );
}

const PAYLOAD = z.object({ ok: z.boolean() });

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('status mapping', () => {
  it('parses a 200 through the schema', async () => {
    const { baseUrl } = await listen(withMeta((_req, res) => json(res, 200, { ok: true })));
    await expect(client(baseUrl).get('/api/x', PAYLOAD)).resolves.toEqual({ ok: true });
  });

  it('maps 401 without the proxy header to credential_rejected', async () => {
    const { baseUrl } = await listen(withMeta((_req, res) => json(res, 401, { error: 'Unauthorized' })));
    await expect(client(baseUrl).get('/api/x', PAYLOAD)).rejects.toMatchObject({ code: 'credential_rejected' });
  });

  it('maps a proxied 401 to node_credential_rejected', async () => {
    const { baseUrl } = await listen(withMeta((_req, res) => json(
      res, 401, { error: 'Unauthorized' }, { 'x-sencho-proxy': '1' },
    )));
    await expect(client(baseUrl).get('/api/x', PAYLOAD)).rejects.toMatchObject({ code: 'node_credential_rejected' });
  });

  it.each([
    ['SCOPE_DENIED', 'scope_denied'],
    ['PERMISSION_DENIED', 'permission_denied'],
  ])('maps 403 %s to %s', async (code, expected) => {
    const { baseUrl } = await listen(withMeta((_req, res) => json(res, 403, { error: 'no', code })));
    await expect(client(baseUrl).get('/api/x', PAYLOAD)).rejects.toMatchObject({ code: expected });
  });

  it('maps a codedless 403 to unsupported (mixed-version RBAC gate)', async () => {
    const { baseUrl } = await listen(withMeta((_req, res) => json(res, 403, { error: 'no' })));
    await expect(client(baseUrl).get('/api/x', PAYLOAD)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('maps 400 capability_unavailable to unsupported', async () => {
    const { baseUrl } = await listen(withMeta((_req, res) => json(res, 400, { error: 'no', code: 'capability_unavailable' })));
    await expect(client(baseUrl).get('/api/x', PAYLOAD)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it.each([
    ['NODE_NOT_FOUND', 'node_not_found'],
    ['STACK_NOT_FOUND', 'stack_not_found'],
  ])('maps 404 %s to %s', async (code, expected) => {
    const { baseUrl } = await listen(withMeta((_req, res) => json(res, 404, { error: 'no', code })));
    await expect(client(baseUrl).get('/api/x', PAYLOAD)).rejects.toMatchObject({ code: expected });
  });

  it('maps a codeless 404 to unexpected_response', async () => {
    const { baseUrl } = await listen(withMeta((_req, res) => json(res, 404, { error: 'API endpoint not found' })));
    await expect(client(baseUrl).get('/api/x', PAYLOAD)).rejects.toMatchObject({ code: 'unexpected_response' });
  });

  it.each([502, 503, 504])('maps %i to node_unreachable', async (status) => {
    const { baseUrl } = await listen(withMeta((_req, res) => json(res, status, { error: 'down' })));
    await expect(client(baseUrl).get('/api/x', PAYLOAD)).rejects.toMatchObject({ code: 'node_unreachable' });
  });

  it('refuses a schema mismatch', async () => {
    const { baseUrl } = await listen(withMeta((_req, res) => json(res, 200, { ok: 'yes' })));
    await expect(client(baseUrl).get('/api/x', PAYLOAD)).rejects.toMatchObject({ code: 'unexpected_response' });
  });
});

describe('the hub capability check', () => {
  it('answers unsupported for every call when the hub does not advertise observation', async () => {
    const { baseUrl, requests } = await listen((_req, res) => json(res, 200, { capabilities: ['stacks'] }));
    await expect(client(baseUrl).get('/api/x', PAYLOAD)).rejects.toMatchObject({ code: 'unsupported' });
    expect(requests).toEqual(['GET /api/meta']);
  });

  it('never sends the credential to the public meta probe', async () => {
    const seen: Array<{ url?: string; auth?: string }> = [];
    const { baseUrl } = await listen((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      if (req.url === '/api/meta') {
        json(res, 200, { capabilities: ['agent-observation-v1'] });
        return;
      }
      json(res, 200, { ok: true });
    });
    await client(baseUrl).get('/api/meta-probe-check', PAYLOAD);
    expect(seen.find((entry) => entry.url === '/api/meta')?.auth).toBeUndefined();
    expect(seen.find((entry) => entry.url === '/api/meta-probe-check')?.auth).toBe(`Bearer ${TOKEN}`);
  });
});

describe('redirects, size, timeouts and cancellation', () => {
  it('refuses a redirect without contacting or credentialing the target', async () => {
    const target = await listen((_req, res) => json(res, 200, { ok: true }));
    const source = await listen(withMeta((_req, res) => {
      res.writeHead(302, { Location: `${target.baseUrl.toString()}steal` });
      res.end();
    }));

    await expect(client(source.baseUrl).get('/api/x', PAYLOAD)).rejects.toMatchObject({ code: 'redirect_refused' });
    expect(target.requests).toEqual([]);
  });

  it('refuses a body over 1 MB', async () => {
    const big = 'x'.repeat(1024 * 1024 + 10);
    const { baseUrl } = await listen(withMeta((_req, res) => json(res, 200, { ok: big })));
    await expect(client(baseUrl).get('/api/x', PAYLOAD)).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('times out', async () => {
    const { baseUrl } = await listen(withMeta(() => { /* never answers */ }));
    await expect(client(baseUrl, { timeoutMs: 100 }).get('/api/x', PAYLOAD))
      .rejects.toMatchObject({ code: 'timeout' });
  });

  it('reports cancellation', async () => {
    const { baseUrl } = await listen(withMeta(() => { /* never answers */ }));
    const controller = new AbortController();
    const pending = client(baseUrl, { timeoutMs: 5_000 })
      .get('/api/x', PAYLOAD, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('rate limiting', () => {
  it('retries once after honoring Retry-After', async () => {
    let calls = 0;
    const { baseUrl } = await listen(withMeta((_req, res) => {
      calls += 1;
      if (calls === 1) {
        json(res, 429, { error: 'slow down' }, { 'retry-after': '2' });
        return;
      }
      json(res, 200, { ok: true });
    }));
    const sleeps: number[] = [];
    await expect(client(baseUrl, { sleep: async (ms) => { sleeps.push(ms); } }).get('/api/x', PAYLOAD))
      .resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([2_000]);
    expect(calls).toBe(2);
  });

  it('reports rate_limited after the single retry, capping a long Retry-After', async () => {
    let calls = 0;
    const { baseUrl } = await listen(withMeta((_req, res) => {
      calls += 1;
      json(res, 429, { error: 'slow down' }, { 'retry-after': '120' });
    }));
    const sleeps: number[] = [];
    await expect(client(baseUrl, { sleep: async (ms) => { sleeps.push(ms); } }).get('/api/x', PAYLOAD))
      .rejects.toMatchObject({ code: 'rate_limited' });
    expect(sleeps).toEqual([5_000]);
    expect(calls).toBe(2);
  });
});

describe('the credential never leaves the client', () => {
  it('never appears in an error message, a URL or a request body', async () => {
    const seen: string[] = [];
    const { baseUrl } = await listen(withMeta((req, res) => {
      seen.push(req.url ?? '');
      json(res, 403, { error: `token ${TOKEN} not allowed`, code: 'SCOPE_DENIED' });
    }));
    try {
      await client(baseUrl).get('/api/x', PAYLOAD);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(TOKEN);
      expect((error as Error).message).not.toContain(TOKEN);
    }
    for (const url of seen) expect(url).not.toContain(TOKEN);
  });

  it('sends the node id as a header and never as a path segment', async () => {
    const seen: Array<{ url?: string; node?: string }> = [];
    const { baseUrl } = await listen(withMeta((req, res) => {
      seen.push({ url: req.url, node: req.headers['x-node-id'] as string | undefined });
      json(res, 200, { ok: true });
    }));
    await client(baseUrl).get('/api/x', PAYLOAD, { nodeId: 4 });
    expect(seen.at(-1)).toEqual({ url: '/api/x', node: '4' });
  });
});
