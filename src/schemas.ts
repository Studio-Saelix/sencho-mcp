/**
 * Zod mirrors of projection v1.
 *
 * This is the adapter's half of the contract: `z.object` strips unknown keys and
 * every enum is closed, so a newer backend field never widens what the model
 * sees, and a value outside the documented set is a refusal rather than a
 * silently relabelled fact.
 */

import { z } from 'zod';

export const READINESS_DOMAINS = [
  'connectivity',
  'workloads',
  'updates',
  'recovery',
  'security',
  'control',
] as const;

export const DOMAIN_STATES = ['attention', 'degraded', 'unavailable', 'unknown', 'healthy'] as const;
export const FINDING_SEVERITIES = ['attention', 'degraded', 'unavailable', 'unknown'] as const;
export const READINESS_VERDICTS = ['ready', 'ready_with_warnings', 'review_required', 'blocked', 'unknown'] as const;
export const ROLLBACK_OVERALLS = ['ready', 'partial', 'not_ready'] as const;
export const READINESS_REASON_CODES = [
  'node_unreachable',
  'pilot_disconnected',
  'contact_stale',
  'probe_timeout',
  'workloads_exited',
  'workloads_partial',
  'workloads_unknown',
  'status_evidence_degraded',
  'status_evidence_stale',
  'update_blocked',
  'update_review_required',
  'update_ready_with_warnings',
  'rollback_not_ready',
  'rollback_partial',
  'snapshot_failed',
  'stacks_unknown',
  'summary_truncated',
  'summary_stale',
  'posture_partial',
  'posture_action_needed',
  'scanner_unavailable',
  'scans_stale',
  'scans_never_completed',
  'control_paused',
  'control_degraded',
  'control_unknown',
  'capability_absent',
  'domain_error',
] as const;

const nodeTransport = z.enum(['local', 'proxy', 'pilot']);
const fleetTransport = z.enum(['local', 'proxy', 'pilot', 'unreachable']);
const nodeState = z.enum(DOMAIN_STATES);
const reasonCode = z.enum(READINESS_REASON_CODES);
const findingSeverity = z.enum(FINDING_SEVERITIES);
const domain = z.enum(READINESS_DOMAINS);

function envelope<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    schemaVersion: z.literal(1),
    generatedAt: z.number().int().nonnegative(),
    data,
  });
}

export const ObservedNodeSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  type: z.enum(['local', 'remote']),
  transport: nodeTransport,
  status: z.enum(['online', 'offline', 'unknown']),
  lastContactAt: z.number().int().nonnegative().nullable(),
  cordoned: z.boolean(),
});

export const NodesResponseSchema = envelope(z.array(ObservedNodeSchema));

export const StackSummarySchema = z.object({
  name: z.string(),
  status: z.enum(['running', 'exited', 'partial', 'unknown']),
  running: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative().nullable(),
  source: z.enum(['local', 'git']),
  isSelf: z.boolean(),
});

export const StackListResponseSchema = envelope(z.object({
  degraded: z.boolean(),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  stacks: z.array(StackSummarySchema),
}));

export const ContainerSchema = z.object({
  name: z.string(),
  service: z.string().nullable(),
  state: z.enum(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead', 'other']),
  health: z.enum(['healthy', 'unhealthy', 'starting', 'none']).nullable(),
  restartCount: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
  startedAt: z.string().nullable(),
});

export const StackStatusResponseSchema = envelope(z.object({
  stack: z.string(),
  outcome: z.enum(['ok', 'unavailable']),
  containers: z.array(ContainerSchema),
  truncated: z.boolean(),
}));

export const StackReadinessResponseSchema = envelope(z.object({
  stack: z.string(),
  update: z.object({
    verdict: z.enum(READINESS_VERDICTS),
    topReasonId: z.string().nullable(),
    hasUpdate: z.boolean(),
    computedAt: z.number().int().nonnegative(),
  }).nullable(),
  rollback: z.object({
    overall: z.enum(ROLLBACK_OVERALLS),
    topReasonId: z.string().nullable(),
    computedAt: z.number().int().nonnegative(),
  }).nullable(),
  unavailableReason: z.enum(['summary_truncated', 'domain_error']).nullable(),
}));

const FleetCellSchema = z.object({
  state: nodeState,
  reasonCode: reasonCode.nullable(),
  evidenceAgeMs: z.number().int().nonnegative().nullable(),
  source: z.enum(['live', 'stored']),
});

const FleetNodeSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  transport: fleetTransport,
  state: nodeState,
  reachability: z.object({
    status: z.enum(['online', 'offline', 'unknown']),
    contactAt: z.number().int().nonnegative().nullable(),
    probedLive: z.boolean(),
    latencyMs: z.number().int().nonnegative().nullable(),
  }),
  // `partialRecord`: a node carries only the domains that apply to it (Control
  // applies only to policy-sync targets), so a full record would reject a valid
  // answer.
  cells: z.partialRecord(domain, FleetCellSchema),
  stackCount: z.number().int().nonnegative().nullable(),
});

export const FleetHealthResponseSchema = envelope(z.object({
  stale: z.boolean(),
  domains: z.array(domain),
  domainsOmitted: z.array(domain),
  summary: z.object({
    nodes: z.record(nodeState, z.number().int().nonnegative()),
    findings: z.record(findingSeverity, z.number().int().nonnegative()),
  }),
  nodes: z.array(FleetNodeSchema),
  findings: z.array(z.object({
    id: z.string(),
    domain,
    nodeId: z.number().int().positive(),
    stack: z.string().nullable(),
    code: reasonCode,
    severity: findingSeverity,
    count: z.number().int().nonnegative(),
  })),
  findingsTruncated: z.boolean(),
}));
