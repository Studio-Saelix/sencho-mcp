/**
 * The protocol: an SDK client spawns the built server over stdio and drives it
 * against a fake Sencho HTTP server.
 *
 * This is the test that proves the adapter is an MCP server at all: five tools
 * are listed, all annotated read-only, and every one of them is called in both
 * an ok state and a failing state through the real stdio transport.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const TOKEN = `sen_sk_${'C'.repeat(49)}`;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const ENVELOPE = (data: unknown) => ({ schemaVersion: 1, generatedAt: 1_700_000_000_000, data });

let sencho: Server;
let baseUrl: string;

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

beforeAll(async () => {
  sencho = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/api/meta') {
      sendJson(res, 200, { version: '0.99.0', capabilities: ['agent-observation-v1'] });
      return;
    }
    if (url === '/api/fleet/observation/nodes') {
      sendJson(res, 200, ENVELOPE([{
        id: 1,
        name: 'hub',
        type: 'local',
        transport: 'local',
        status: 'online',
        lastContactAt: 5,
        cordoned: false,
      }]));
      return;
    }
    if (url.startsWith('/api/stacks/platform/observation')) {
      sendJson(res, 200, ENVELOPE({
        degraded: url.includes('cursor=api'),
        total: 2,
        nextCursor: 'web',
        stacks: [
          { name: 'api', status: 'running', running: 1, total: 1, source: 'local', isSelf: false },
          { name: 'web', status: 'partial', running: 1, total: 2, source: 'git', isSelf: false },
        ],
      }));
      return;
    }
    if (url === '/api/fleet/observation/health') {
      sendJson(res, 200, ENVELOPE({
        stale: false,
        domains: ['connectivity'],
        domainsOmitted: ['control'],
        summary: {
          nodes: { attention: 0, degraded: 0, unavailable: 0, unknown: 0, healthy: 0 },
          findings: { attention: 0, degraded: 0, unavailable: 0, unknown: 0 },
        },
        nodes: [{
          id: 2,
          name: 'edge',
          transport: 'unreachable',
          state: 'unavailable',
          reachability: { status: 'offline', contactAt: null, probedLive: false, latencyMs: null },
          cells: { connectivity: { state: 'unavailable', reasonCode: 'node_unreachable', evidenceAgeMs: null, source: 'stored' } },
          stackCount: null,
        }],
        findings: [],
        findingsTruncated: false,
      }));
      return;
    }
    if (url === '/api/stacks/missing/observation/status') {
      sendJson(res, 404, { error: 'Stack not found', code: 'STACK_NOT_FOUND' });
      return;
    }
    if (url === '/api/stacks/denied/observation/status') {
      sendJson(res, 403, { error: 'nope', code: 'SCOPE_DENIED' });
      return;
    }
    if (url === '/api/stacks/boom/observation/status') {
      sendJson(res, 500, { error: 'boom' });
      return;
    }
    if (url === '/api/stacks/web/observation/status') {
      sendJson(res, 200, ENVELOPE({
        stack: 'web',
        outcome: 'ok',
        truncated: true,
        containers: [{
          name: 'web-1', service: 'web', state: 'running', health: 'healthy',
          restartCount: 0, exitCode: 0, startedAt: '2026-01-01T00:00:00Z',
        }],
      }));
      return;
    }
    if (url === '/api/stacks/unavail/observation/readiness') {
      sendJson(res, 200, ENVELOPE({
        stack: 'unavail',
        update: null,
        rollback: null,
        unavailableReason: 'summary_truncated',
      }));
      return;
    }
    if (url === '/api/stacks/web/observation/readiness') {
      sendJson(res, 200, ENVELOPE({
        stack: 'web',
        update: { verdict: 'review_required', topReasonId: 'containers', hasUpdate: true, computedAt: 9 },
        rollback: { overall: 'partial', topReasonId: 'env_keys', computedAt: 10 },
        unavailableReason: null,
      }));
      return;
    }
    sendJson(res, 404, { error: 'API endpoint not found' });
  });
  await new Promise<void>((resolve) => sencho.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(sencho.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => sencho.close(() => resolve()));
});

interface Session {
  client: Client;
  transport: StdioClientTransport;
  close: () => Promise<void>;
}

async function connect(env: Record<string, string> = {}): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'dist/index.js')],
    env: {
      ...process.env,
      SENCHO_URL: baseUrl,
      SENCHO_TOKEN: TOKEN,
      ...env,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'sencho-mcp-test', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    transport,
    close: async () => {
      await client.close();
    },
  };
}

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe('listing the tools', () => {
  it('lists exactly five, all annotated read-only', async () => {
    const session = await connect();
    try {
      const { tools } = await session.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'sencho_get_fleet_health',
        'sencho_get_stack_readiness',
        'sencho_get_stack_status',
        'sencho_list_nodes',
        'sencho_list_stacks',
      ]);
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.annotations?.destructiveHint).toBe(false);
        expect(tool.annotations?.idempotentHint).toBe(true);
        expect(tool.annotations?.openWorldHint).toBe(false);
        expect(tool.outputSchema).toBeDefined();
      }
    } finally {
      await session.close();
    }
  });
});

describe('calling every tool', () => {
  it('lists nodes', async () => {
    const session = await connect();
    try {
      const result = await session.client.callTool({ name: 'sencho_list_nodes', arguments: {} });
      expect(result.isError).toBeFalsy();
      const body = structured(result);
      expect(body.outcome).toBe('ok');
      expect((body.data as Array<{ name: string }>)[0]?.name).toBe('hub');
    } finally {
      await session.close();
    }
  });

  it('lists stacks and reports a degraded answer as partial', async () => {
    const session = await connect();
    try {
      const ok = structured(await session.client.callTool({
        name: 'sencho_list_stacks',
        arguments: { nodeId: 1, limit: 1 },
      }));
      expect(ok.outcome).toBe('ok');
      expect(ok.target).toEqual({ nodeId: 1 });
      expect((ok.data as { nextCursor: string }).nextCursor).toBe('web');

      const partial = structured(await session.client.callTool({
        name: 'sencho_list_stacks',
        arguments: { nodeId: 1, cursor: 'api' },
      }));
      expect(partial.outcome).toBe('partial');
    } finally {
      await session.close();
    }
  });

  it('reports stack status, truncation, a missing stack and a denied token', async () => {
    const session = await connect();
    try {
      const truncated = await session.client.callTool({
        name: 'sencho_get_stack_status',
        arguments: { nodeId: 1, stack: 'web' },
      });
      expect(truncated.isError).toBeFalsy();
      expect(structured(truncated).outcome).toBe('partial');

      const missing = await session.client.callTool({
        name: 'sencho_get_stack_status',
        arguments: { nodeId: 1, stack: 'missing' },
      });
      expect(missing.isError).toBe(true);
      expect(structured(missing).outcome).toBe('not_found');
      expect((structured(missing).error as { code: string }).code).toBe('stack_not_found');

      const denied = await session.client.callTool({
        name: 'sencho_get_stack_status',
        arguments: { nodeId: 1, stack: 'denied' },
      });
      expect(structured(denied).outcome).toBe('denied');
      expect((structured(denied).error as { code: string }).code).toBe('scope_denied');

      const boom = await session.client.callTool({
        name: 'sencho_get_stack_status',
        arguments: { nodeId: 1, stack: 'boom' },
      });
      expect(structured(boom).outcome).toBe('error');
      expect((structured(boom).error as { code: string }).code).toBe('unexpected_response');
    } finally {
      await session.close();
    }
  });

  it('reports readiness and an unavailable row', async () => {
    const session = await connect();
    try {
      const ready = structured(await session.client.callTool({
        name: 'sencho_get_stack_readiness',
        arguments: { nodeId: 1, stack: 'web' },
      }));
      expect(ready.outcome).toBe('ok');
      expect((ready.data as { update: { verdict: string } }).update.verdict).toBe('review_required');

      const unavailable = await session.client.callTool({
        name: 'sencho_get_stack_readiness',
        arguments: { nodeId: 1, stack: 'unavail' },
      });
      expect(unavailable.isError).toBe(true);
      expect(structured(unavailable).outcome).toBe('unavailable');
    } finally {
      await session.close();
    }
  });

  it('reports fleet health and marks an unreachable node partial', async () => {
    const session = await connect();
    try {
      const result = await session.client.callTool({ name: 'sencho_get_fleet_health', arguments: {} });
      expect(result.isError).toBeFalsy();
      const body = structured(result);
      expect(body.outcome).toBe('partial');
      expect((body.data as { domainsOmitted: string[] }).domainsOmitted).toContain('control');
    } finally {
      await session.close();
    }
  });

  it('refuses to start tools when the hub does not advertise observation', async () => {
    // A second fake hub without the capability: /api/meta is the only call.
    const plain = createServer((req, res) => {
      if (req.url === '/api/meta') {
        sendJson(res, 200, { version: '0.90.0', capabilities: ['stacks'] });
        return;
      }
      sendJson(res, 404, { error: 'API endpoint not found' });
    });
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    const port = (plain.address() as AddressInfo).port;
    const session = await connect({ SENCHO_URL: `http://127.0.0.1:${port}` });
    try {
      const result = await session.client.callTool({ name: 'sencho_list_nodes', arguments: {} });
      expect(result.isError).toBe(true);
      expect(structured(result).outcome).toBe('unsupported');
    } finally {
      await session.close();
      await new Promise<void>((resolve) => plain.close(() => resolve()));
    }
  });

  it('never prints the token to stderr', async () => {
    const session = await connect();
    const chunks: string[] = [];
    session.transport.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    try {
      await session.client.callTool({ name: 'sencho_list_nodes', arguments: {} });
    } finally {
      await session.close();
    }
    expect(chunks.join('')).not.toContain(TOKEN);
  });
});
