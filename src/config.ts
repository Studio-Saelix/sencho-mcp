/**
 * Configuration, read once from the environment at startup.
 *
 * The credential is deliberately read from a file when one is configured:
 * pointing a client's JSON at a file keeps the token out of the client's own
 * configuration and out of any config-sync service that watches that file.
 */

import { readFileSync } from 'node:fs';

export const TOKEN_PREFIX = 'sen_sk_';
export const TOKEN_PATTERN = /^sen_sk_[A-Za-z0-9]{49}$/;

export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 60_000;

export interface Config {
  baseUrl: URL;
  token: string;
  timeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

/**
 * Parse a base URL, refusing everything a fixed-path client cannot honour.
 *
 * The client builds every request from a fixed path template, so userinfo, a
 * query or a fragment in the base has no place to go and would silently
 * reshape the URL. Refusing them keeps "the only outbound destination is the
 * hub the operator configured" literally true.
 */
export function parseBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('SENCHO_URL must be an absolute http(s) URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('SENCHO_URL must use http or https.');
  }
  if (url.username || url.password) {
    throw new ConfigError('SENCHO_URL must not carry credentials; use SENCHO_TOKEN_FILE.');
  }
  if (url.search || url.hash) {
    throw new ConfigError('SENCHO_URL must not carry a query string or fragment.');
  }
  return url;
}

export function validateToken(token: string): string {
  const trimmed = token.trim();
  if (!TOKEN_PATTERN.test(trimmed)) {
    throw new ConfigError('The Sencho token is not in the expected sen_sk_ format.');
  }
  return trimmed;
}

export function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  if (!/^[0-9]+$/.test(raw)) {
    throw new ConfigError('SENCHO_TIMEOUT_MS must be a whole number of milliseconds.');
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new ConfigError(`SENCHO_TIMEOUT_MS must be between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  return value;
}

export interface ConfigDeps {
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
  warn?: (message: string) => void;
}

/** Load and validate configuration. Throws ConfigError with an actionable message. */
export function loadConfig(deps: ConfigDeps = {}): Config {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  const rawUrl = env.SENCHO_URL;
  if (!rawUrl) throw new ConfigError('SENCHO_URL is required.');
  const baseUrl = parseBaseUrl(rawUrl.trim());

  const tokenFile = env.SENCHO_TOKEN_FILE;
  const inlineToken = env.SENCHO_TOKEN;
  if (!tokenFile && !inlineToken) {
    throw new ConfigError('Set SENCHO_TOKEN_FILE (preferred) or SENCHO_TOKEN.');
  }
  let rawToken: string;
  if (tokenFile) {
    try {
      rawToken = readFile(tokenFile);
    } catch {
      // The path itself is not echoed: a filename can be as sensitive as the
      // token to the operator reading a log.
      throw new ConfigError('Could not read the token file named by SENCHO_TOKEN_FILE.');
    }
  } else {
    rawToken = inlineToken as string;
  }
  const token = validateToken(rawToken);

  if (baseUrl.protocol === 'http:' && !isLoopbackHost(baseUrl.hostname)) {
    warn(
      'sencho-mcp: SENCHO_URL uses plain http to a non-loopback host. '
      + 'The token travels in a header on every request; use https or a trusted private network.',
    );
  }

  return { baseUrl, token, timeoutMs: parseTimeout(env.SENCHO_TIMEOUT_MS) };
}
