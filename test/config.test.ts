import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  loadConfig,
  parseBaseUrl,
  parseTimeout,
  validateToken,
} from '../src/config.js';

const TOKEN = `sen_sk_${'A'.repeat(49)}`;

describe('parseBaseUrl', () => {
  it('accepts http and https', () => {
    expect(parseBaseUrl('https://sencho.example.com').toString()).toBe('https://sencho.example.com/');
    expect(parseBaseUrl('http://127.0.0.1:1852').toString()).toBe('http://127.0.0.1:1852/');
  });

  it.each([
    'not a url',
    'ftp://sencho.example.com',
    'https://user:pass@sencho.example.com',
    'https://sencho.example.com/?x=1',
    'https://sencho.example.com/#frag',
  ])('refuses %s', (value) => {
    expect(() => parseBaseUrl(value)).toThrow(ConfigError);
  });
});

describe('validateToken', () => {
  it('accepts the sen_sk_ shape', () => {
    expect(validateToken(TOKEN)).toBe(TOKEN);
    expect(validateToken(` ${TOKEN}\n`)).toBe(TOKEN);
  });

  it.each(['', 'nope', `sen_sk_${'A'.repeat(48)}`, `sen_sk_${'A'.repeat(50)}`, `sen_sk_${'A'.repeat(48)}-`])(
    'refuses %s',
    (value) => {
      expect(() => validateToken(value)).toThrow(ConfigError);
    },
  );
});

describe('parseTimeout', () => {
  it('defaults, bounds and rejects junk', () => {
    expect(parseTimeout(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(parseTimeout('2500')).toBe(2500);
    expect(parseTimeout(String(MAX_TIMEOUT_MS))).toBe(MAX_TIMEOUT_MS);
    for (const value of ['0', String(MAX_TIMEOUT_MS + 1), '1.5', 'abc', '-1']) {
      expect(() => parseTimeout(value)).toThrow(ConfigError);
    }
  });
});

describe('loadConfig', () => {
  it('reads the token from a file', () => {
    const config = loadConfig({
      env: { SENCHO_URL: 'https://sencho.example.com', SENCHO_TOKEN_FILE: '/run/secrets/token' },
      readFile: () => `${TOKEN}\n`,
      warn: () => undefined,
    });
    expect(config.token).toBe(TOKEN);
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('prefers the token file over an inline token', () => {
    const config = loadConfig({
      env: {
        SENCHO_URL: 'https://sencho.example.com',
        SENCHO_TOKEN_FILE: '/run/secrets/token',
        SENCHO_TOKEN: `sen_sk_${'B'.repeat(49)}`,
      },
      readFile: () => TOKEN,
      warn: () => undefined,
    });
    expect(config.token).toBe(TOKEN);
  });

  it('requires a URL and a credential', () => {
    expect(() => loadConfig({ env: {}, warn: () => undefined })).toThrow(/SENCHO_URL/);
    expect(() => loadConfig({
      env: { SENCHO_URL: 'https://sencho.example.com' },
      warn: () => undefined,
    })).toThrow(/SENCHO_TOKEN_FILE/);
  });

  it('does not echo the token file path when it cannot be read', () => {
    try {
      loadConfig({
        env: { SENCHO_URL: 'https://sencho.example.com', SENCHO_TOKEN_FILE: '/srv/secret-name' },
        readFile: () => { throw new Error('ENOENT'); },
        warn: () => undefined,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('/srv/secret-name');
    }
  });

  it('warns about plaintext http to a non-loopback host, without the token', () => {
    const warnings: string[] = [];
    loadConfig({
      env: { SENCHO_URL: 'http://sencho.example.com:1852', SENCHO_TOKEN: TOKEN },
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/plain http/);
    expect(warnings[0]).not.toContain(TOKEN);
  });

  it('does not warn for http on loopback', () => {
    const warnings: string[] = [];
    loadConfig({
      env: { SENCHO_URL: 'http://localhost:1852', SENCHO_TOKEN: TOKEN },
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
  });
});
