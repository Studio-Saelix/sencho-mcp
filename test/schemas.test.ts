import { describe, expect, it } from 'vitest';
import {
  FleetHealthResponseSchema,
  NodesResponseSchema,
  StackListResponseSchema,
  StackStatusResponseSchema,
} from '../src/schemas.js';

const ENVELOPE = { schemaVersion: 1 as const, generatedAt: 10 };

describe('closed enums and unknown fields', () => {
  it('strips unknown fields instead of widening the model view', () => {
    const parsed = NodesResponseSchema.parse({
      ...ENVELOPE,
      extraTopLevel: 'ignored',
      data: [{
        id: 1, name: 'hub', type: 'local', transport: 'local', status: 'online',
        lastContactAt: null, cordoned: false, api_url: 'https://secret.example.com', compose_dir: '/srv',
      }],
    });
    expect(parsed.data[0]).not.toHaveProperty('api_url');
    expect(parsed.data[0]).not.toHaveProperty('compose_dir');
    expect(parsed).not.toHaveProperty('extraTopLevel');
  });

  it('rejects an unrecognized closed-enum value', () => {
    expect(() => StackStatusResponseSchema.parse({
      ...ENVELOPE,
      data: {
        stack: 'web',
        outcome: 'ok',
        truncated: false,
        containers: [{
          name: 'web-1', service: null, state: 'hibernating', health: null,
          restartCount: 0, exitCode: null, startedAt: null,
        }],
      },
    })).toThrow();
  });

  it('rejects a wrong schema version', () => {
    expect(() => NodesResponseSchema.parse({ schemaVersion: 2, generatedAt: 1, data: [] })).toThrow();
  });

  it('rejects an unknown readiness verdict', () => {
    expect(() => StackStatusResponseSchema.parse({
      ...ENVELOPE,
      data: { stack: 'web', outcome: 'ok', containers: [], truncated: false },
    })).not.toThrow();
    expect(() => StackListResponseSchema.parse({
      ...ENVELOPE,
      data: { degraded: false, total: 1, nextCursor: null, stacks: [{ name: 'web', status: 'exploded', running: 1, total: 1, source: 'local', isSelf: false }] },
    })).toThrow();
  });

  it('accepts the full fleet payload shapes it mirrors', () => {
    const parsed = FleetHealthResponseSchema.parse({
      ...ENVELOPE,
      data: {
        stale: false,
        domains: ['connectivity', 'workloads'],
        domainsOmitted: ['control'],
        summary: {
          nodes: { attention: 0, degraded: 0, unavailable: 0, unknown: 0, healthy: 1 },
          findings: { attention: 0, degraded: 0, unavailable: 0, unknown: 0 },
        },
        nodes: [{
          id: 1,
          name: 'hub',
          transport: 'local',
          state: 'healthy',
          reachability: { status: 'online', contactAt: 1, probedLive: true, latencyMs: 2 },
          cells: { connectivity: { state: 'healthy', reasonCode: null, evidenceAgeMs: 5, source: 'live' } },
          stackCount: 1,
        }],
        findings: [],
        findingsTruncated: false,
      },
    });
    expect(parsed.data.nodes[0]?.cells.connectivity?.state).toBe('healthy');
  });
});
