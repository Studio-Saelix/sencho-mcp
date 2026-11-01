/**
 * End to end against a real Sencho container.
 *
 * Opt-in: set `SENCHO_IMAGE` to an image that includes the observation
 * endpoints. The suite starts the image with a host-port mapping onto the
 * container's fixed listen port, completes first-run setup, creates a token,
 * drives every tool through the real adapter, then proves revocation and the
 * scope refusal.
 *
 *   SENCHO_IMAGE=ghcr.io/studio-saelix/sencho-dev:dev npm run test:e2e
 */

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IMAGE = process.env.SENCHO_IMAGE;
const NAME = `sencho-mcp-e2e-${process.pid}`;
const PORT = 20_000 + (process.pid % 1_000);
const BASE = `http://127.0.0.1:${PORT}`;
// The container listens on its built-in port; `PORT` is only the host side of
// the mapping, because the server does not read a PORT environment variable.
const CONTAINER_PORT = 1852;
const ADMIN = { username: 'e2e-admin', password: 'e2e-password-123' };

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Sencho did not become ready');
}

async function api(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${pathname}`, init);
}

async function login(): Promise<string> {
  const response = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('login returned no session cookie');
  return cookie;
}

async function createToken(cookie: string, name: string, scope: string): Promise<{ id: number; token: string }> {
  const response = await api('/api/api-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name, scope, expires_in: 90 }),
  });
  if (!response.ok) throw new Error(`create ${scope} token failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<{ id: number; token: string }>;
}

async function revoke(cookie: string, id: number): Promise<void> {
  const response = await api(`/api/api-tokens/${id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  if (!response.ok) throw new Error(`revoke failed: ${response.status}`);
}

async function connect(token: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'dist/index.js')],
    env: { ...process.env, SENCHO_URL: BASE, SENCHO_TOKEN: token },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'sencho-mcp-e2e', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

describe.skipIf(!IMAGE)('against a real Sencho container', () => {
  beforeAll(async () => {
    docker('rm', '-f', NAME);
    docker(
      'run', '-d', '--name', NAME,
      '-p', `${PORT}:${CONTAINER_PORT}`,
      // The stack reads come from the Docker engine the node manages, so the
      // container needs the socket to answer them. Without it the list read
      // fails and this suite would be testing an environment, not the adapter.
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-e', 'JWT_SECRET=e2e-secret-e2e-secret-e2e-secret-e2e',
      IMAGE as string,
    );
    await waitFor(async () => (await api('/api/auth/status')).ok, 180_000);
    const setup = await api('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ADMIN, confirmPassword: ADMIN.password }),
    });
    if (!setup.ok) throw new Error(`setup failed: ${setup.status} ${await setup.text()}`);
    const cookie = await login();
    await api('/api/stacks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ stackName: 'e2e-observe' }),
    });
  }, 240_000);

  afterAll(() => {
    try {
      docker('rm', '-f', NAME);
    } catch {
      // best effort
    }
  });

  it('calls every tool with an observe token, then survives revocation', async () => {
    const cookie = await login();
    const observe = await createToken(cookie, 'e2e-observe', 'observe-only');
    const client = await connect(observe.token);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(5);

      const nodes = await client.callTool({ name: 'sencho_list_nodes', arguments: {} });
      expect(nodes.isError).toBeFalsy();

      const list = await client.callTool({ name: 'sencho_list_stacks', arguments: { nodeId: 1 } });
      expect(list.isError).toBeFalsy();
      const stacks = (list.structuredContent as { data: { stacks: Array<{ name: string }> } }).data.stacks;
      expect(stacks.some((stack) => stack.name === 'e2e-observe')).toBe(true);

      // The stack has no containers, so the honest answer is an empty list with
      // `outcome: ok`; a node whose Docker read fails answers `unavailable`
      // with a 200, and the adapter must report either, not throw.
      const status = await client.callTool({
        name: 'sencho_get_stack_status',
        arguments: { nodeId: 1, stack: 'e2e-observe' },
      });
      expect(['ok', 'partial', 'unavailable']).toContain(
        (status.structuredContent as { outcome: string }).outcome,
      );

      const readiness = await client.callTool({
        name: 'sencho_get_stack_readiness',
        arguments: { nodeId: 1, stack: 'e2e-observe' },
      });
      expect(['ok', 'partial', 'unavailable']).toContain(
        (readiness.structuredContent as { outcome: string }).outcome,
      );

      const health = await client.callTool({ name: 'sencho_get_fleet_health', arguments: {} });
      expect(health.isError).toBeFalsy();

      await revoke(cookie, observe.id);
      const after = await client.callTool({ name: 'sencho_list_nodes', arguments: {} });
      expect(after.isError).toBe(true);
      expect((after.structuredContent as { error: { code: string } }).error.code).toBe('credential_rejected');
    } finally {
      await client.close();
    }
  }, 120_000);

  // Read Only is deliberately left as broad as it is today: it passes every
  // GET, and the observation endpoints are GETs like any other. Narrowing it
  // would break existing automations, so the observation restriction belongs to
  // Observe Only. An operator who wants the narrow credential uses that scope.
  it('reads observation with a Read Only token, which stays broad by design', async () => {
    const cookie = await login();
    const readOnly = await createToken(cookie, 'e2e-read-only', 'read-only');
    const client = await connect(readOnly.token);
    try {
      const result = await client.callTool({ name: 'sencho_list_nodes', arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
      await revoke(cookie, readOnly.id);
    }
  }, 120_000);

  it('refuses a token that was never issued', async () => {
    const client = await connect(`sen_sk_${'Z'.repeat(49)}`);
    try {
      const result = await client.callTool({ name: 'sencho_list_nodes', arguments: {} });
      expect((result.structuredContent as { error: { code: string } }).error.code).toBe('credential_rejected');
    } finally {
      await client.close();
    }
  }, 120_000);
});
