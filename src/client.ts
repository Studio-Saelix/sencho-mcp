/**
 * The HTTP client, and the whole of the adapter's authority.
 *
 * Three rules hold here and are tested:
 *  - the model never supplies a path, method or URL; every request is built from
 *    a fixed template and the request's own validated parameters,
 *  - the token is sent only in the `Authorization` header and never appears in a
 *    message, a log line or a URL,
 *  - a response that cannot be trusted (a redirect, an oversized body, a body
 *    the schema rejects) is refused rather than relayed.
 */

import type { Config } from './config.js';

export type ObservationErrorCode =
  | 'credential_rejected'
  | 'node_credential_rejected'
  | 'scope_denied'
  | 'permission_denied'
  | 'unsupported'
  | 'node_not_found'
  | 'stack_not_found'
  | 'node_unreachable'
  | 'rate_limited'
  | 'unexpected_response'
  | 'redirect_refused'
  | 'response_too_large'
  | 'timeout'
  | 'cancelled';

export type Outcome =
  | 'ok'
  | 'partial'
  | 'unavailable'
  | 'unsupported'
  | 'denied'
  | 'not_found'
  | 'error';

export class ObservationError extends Error {
  readonly code: ObservationErrorCode;

  constructor(code: ObservationErrorCode, message: string) {
    super(message);
    this.name = 'ObservationError';
    this.code = code;
  }
}

/** A fixed, human-readable sentence per code. Server prose is never relayed. */
export const ERROR_MESSAGES: Record<ObservationErrorCode, string> = {
  credential_rejected:
    'Sencho rejected the token. It may have been revoked or expired; create a new Observe Only token in Settings.',
  node_credential_rejected:
    'The hub could not authenticate to the node. Its stored node credential needs re-enrolling, which a new token will not fix.',
  scope_denied:
    'This token is not an Observe Only token. Create one with the Observe Only scope in Settings and use that instead.',
  permission_denied: 'The token is not permitted to read this. Check its role on the hub.',
  unsupported:
    'This Sencho node does not support agent observation. It needs a version that advertises agent-observation-v1.',
  node_not_found: 'No node with that id exists on this hub.',
  stack_not_found: 'No stack with that name exists on that node.',
  node_unreachable: 'The node could not be reached. Check that it is online and its transport is connected.',
  rate_limited: 'Sencho rate-limited this token. Wait a moment and try again.',
  unexpected_response: 'Sencho answered with a response this client does not understand.',
  redirect_refused: 'Sencho answered with a redirect; this client refuses to follow one.',
  response_too_large: 'Sencho answered with more than 1 MB; this client refuses to read it.',
  timeout: 'Sencho did not answer before the configured timeout.',
  cancelled: 'The request was cancelled.',
};

export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_CONCURRENT_REQUESTS = 2;
const RETRY_AFTER_CAP_MS = 5_000;

export function outcomeFor(error: ObservationError): Outcome {
  switch (error.code) {
    case 'unsupported':
      return 'unsupported';
    case 'scope_denied':
    case 'permission_denied':
      return 'denied';
    case 'node_not_found':
    case 'stack_not_found':
      return 'not_found';
    default:
      return 'error';
  }
}

export interface RequestOptions {
  nodeId?: number;
  signal?: AbortSignal;
}

type FetchLike = typeof fetch;

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

/** A counting semaphore: at most two requests are ever in flight. */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT_REQUESTS) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export class SenchoClient {
  private readonly config: Config;
  private readonly fetchImpl: FetchLike;
  private readonly semaphore = new Semaphore();
  private readonly sleep: (ms: number) => Promise<void>;
  private hubCapability: Promise<boolean> | null = null;

  constructor(
    config: Config,
    options: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Whether the hub serves observation at all. Checked once, lazily, through the
   * public `/api/meta`, so a client pointed at an older hub gets `unsupported`
   * from every tool instead of a misleading 404.
   */
  async hubSupportsObservation(): Promise<boolean> {
    this.hubCapability ??= this.readHubCapability();
    return this.hubCapability;
  }

  private async readHubCapability(): Promise<boolean> {
    try {
      const response = await this.semaphore.run(() => this.request('/api/meta', { authenticated: false }));
      if (response.status !== 200) return false;
      const body = JSON.parse(response.text) as { capabilities?: unknown };
      return Array.isArray(body.capabilities) && body.capabilities.includes('agent-observation-v1');
    } catch {
      return false;
    }
  }

  /** GET a fixed path and parse it. */
  async get<T>(
    path: string,
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
    options: RequestOptions = {},
    attempt = 0,
  ): Promise<T> {
    if (!(await this.hubSupportsObservation())) {
      throw new ObservationError('unsupported', ERROR_MESSAGES.unsupported);
    }
    const response = await this.semaphore.run(() => this.request(path, options));
    if (response.status === 429) {
      if (attempt >= 1) throw new ObservationError('rate_limited', ERROR_MESSAGES.rate_limited);
      await this.sleep(this.retryDelay(response.headers));
      return this.get(path, schema, options, attempt + 1);
    }
    this.throwForStatus(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new ObservationError('unexpected_response', ERROR_MESSAGES.unexpected_response);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new ObservationError('unexpected_response', ERROR_MESSAGES.unexpected_response);
    }
    return result.data;
  }

  private retryDelay(headers: Headers): number {
    const raw = headers.get('retry-after');
    const seconds = raw === null ? Number.NaN : Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) return 1_000;
    return Math.min(seconds * 1_000, RETRY_AFTER_CAP_MS);
  }

  private throwForStatus(response: RawResponse): void {
    const status = response.status;
    if (status === 401) {
      const viaProxy = response.headers.get('x-sencho-proxy') === '1';
      throw new ObservationError(
        viaProxy ? 'node_credential_rejected' : 'credential_rejected',
        ERROR_MESSAGES[viaProxy ? 'node_credential_rejected' : 'credential_rejected'],
      );
    }
    if (status === 403) {
      const code = this.readErrorCode(response.text);
      if (code === 'SCOPE_DENIED') throw new ObservationError('scope_denied', ERROR_MESSAGES.scope_denied);
      if (code === 'PERMISSION_DENIED') throw new ObservationError('permission_denied', ERROR_MESSAGES.permission_denied);
      // A coded 403 is a decision; an uncoded one is the mixed-version RBAC
      // gate, which means the node is too old to enforce per-user permissions.
      throw new ObservationError('unsupported', ERROR_MESSAGES.unsupported);
    }
    if (status === 400) {
      const code = this.readErrorCode(response.text);
      if (code === 'capability_unavailable') throw new ObservationError('unsupported', ERROR_MESSAGES.unsupported);
      throw new ObservationError('unexpected_response', ERROR_MESSAGES.unexpected_response);
    }
    if (status === 404) {
      const code = this.readErrorCode(response.text);
      if (code === 'NODE_NOT_FOUND') throw new ObservationError('node_not_found', ERROR_MESSAGES.node_not_found);
      if (code === 'STACK_NOT_FOUND') throw new ObservationError('stack_not_found', ERROR_MESSAGES.stack_not_found);
      throw new ObservationError('unexpected_response', ERROR_MESSAGES.unexpected_response);
    }
    if (status === 502 || status === 503 || status === 504) {
      throw new ObservationError('node_unreachable', ERROR_MESSAGES.node_unreachable);
    }
    if (status >= 200 && status < 300) return;
    throw new ObservationError('unexpected_response', ERROR_MESSAGES.unexpected_response);
  }

  private readErrorCode(text: string): unknown {
    try {
      const body = JSON.parse(text) as { code?: unknown };
      return body.code;
    } catch {
      return undefined;
    }
  }

  private async request(path: string, options: RequestOptions & { authenticated?: boolean }): Promise<RawResponse> {
    const url = new URL(path, this.config.baseUrl);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `sencho-mcp/${process.env.npm_package_version ?? '0.1.0'}`,
    };
    // The meta probe is public; sending the credential there would spread it to
    // a request that does not need it.
    if (options.authenticated !== false) headers.Authorization = `Bearer ${this.config.token}`;
    if (options.nodeId !== undefined) headers['x-node-id'] = String(options.nodeId);

    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const requestSignal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: requestSignal,
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'TimeoutError') throw new ObservationError('timeout', ERROR_MESSAGES.timeout);
      if (name === 'AbortError') throw new ObservationError('cancelled', ERROR_MESSAGES.cancelled);
      throw new ObservationError('node_unreachable', ERROR_MESSAGES.node_unreachable);
    }

    if (response.status >= 300 && response.status < 400) {
      // Never read the body and never re-send the token: the destination of a
      // redirect is chosen by the server, not by the operator.
      await response.body?.cancel().catch(() => undefined);
      throw new ObservationError('redirect_refused', ERROR_MESSAGES.redirect_refused);
    }

    const text = await this.readBounded(response);
    return { status: response.status, headers: response.headers, text };
  }

  /** Read at most 1 MB; an oversized body is refused, not truncated. */
  private async readBounded(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new ObservationError('response_too_large', ERROR_MESSAGES.response_too_large);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof ObservationError) throw error;
      const name = (error as { name?: string }).name;
      if (name === 'TimeoutError') throw new ObservationError('timeout', ERROR_MESSAGES.timeout);
      if (name === 'AbortError') throw new ObservationError('cancelled', ERROR_MESSAGES.cancelled);
      throw new ObservationError('unexpected_response', ERROR_MESSAGES.unexpected_response);
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  }
}
