# Architecture

This is the public summary of the architecture decision behind `sencho-mcp`. The full
internal record lives with the Sencho implementation; this page is what a user of the
adapter needs.

## Shape

```
MCP client  ──stdio──▶  sencho-mcp  ──HTTPS──▶  Sencho hub
                                                  │
                                                  ├─ local node
                                                  ├─ Direct Proxy node
                                                  └─ Pilot tunnel node
```

The adapter is a separately installed, versioned Node package. It speaks local stdio MCP
only and calls Sencho's REST API. It is not embedded in the Sencho server, holds no
database, and shares no release cycle with Sencho.

## Why not in-process

An MCP runtime inside the Sencho server would need a network-exposed transport
(Streamable HTTP), which brings its own origin, session and authentication threat model.
It would also put a second release-cadence component in the control plane and pull the
MCP SDK into the Sencho image and its SBOM. A local stdio process keeps the control plane
unchanged and makes removing the adapter a no-op for Sencho.

## The boundary

Each tool maps to one fixed projection endpoint:

| Tool | Endpoint |
|---|---|
| `sencho_list_nodes` | `GET /api/fleet/observation/nodes` |
| `sencho_list_stacks` | `GET /api/stacks/platform/observation` |
| `sencho_get_stack_status` | `GET /api/stacks/:stack/observation/status` |
| `sencho_get_stack_readiness` | `GET /api/stacks/:stack/observation/readiness` |
| `sencho_get_fleet_health` | `GET /api/fleet/observation/health` |

The adapter never takes a path, method, URL or free parameter from the model. It exposes
no OpenAPI document and no arbitrary-request tool.

## Authentication and authorization

The credential is a Sencho API token with the **Observe Only** scope, which must have an
expiry. That scope is a value of Sencho's existing token-scope engine, not a new
permission system:

- HTTP: exactly those five `GET`s, on any other path a 403 `SCOPE_DENIED`.
- WebSocket: refused on every path.
- The two account-introspection routes mounted ahead of the scope gate also refuse it.
- The token's role is viewer, so the hub's ordinary role checks, stack classifier and
  remote-node gates still run on every hop.

The token holds viewer-level reads for every node the hub manages and cannot be narrowed
to a node or a stack. A leaked observe token reveals only what the projections reveal.

## Threat model

| Concern | Mitigation |
|---|---|
| Prompt injection through returned names | Names are bounded, tool descriptions mark them as data, and no free-text reason prose is returned; reasons are closed enum ids |
| Credential theft | A narrow scope, a token file instead of client JSON, a required expiry, revocation |
| Over-disclosure | Allowlisted projections; a strict schema parse in the adapter strips unknown fields and validates closed enums |
| A malicious MCP client | It holds only the observe token, and the backend enforces that token |
| Cross-node access | The hub's proxy gates, the stack classifier and per-node routing |
| SSRF | One configured base URL, fixed path templates, redirects refused, no tool takes a URL |
| Rate abuse | The per-token limiter, one shared 15-second fleet-health cache, two requests in flight in the adapter |
| Supply chain | Two runtime dependencies, a lockfile, Dependabot, provenance-signed publishing once a registry channel exists |

## Compatibility

Every projection carries `schemaVersion: 1`, and the hub advertises
`agent-observation-v1`. A hub without the capability, or a node without it, answers
`unsupported`. The adapter checks the hub's `/api/meta` once and reports `unsupported`
from every tool rather than failing per call with a misleading 404.

`generatedAt`, `stale`, `degraded` and `truncated` pass through, so an incomplete answer
is never presented as a healthy one.

## Release boundary

Write tools, diagnostic tools (logs, drift, scans, GitOps, Blueprints), a network-exposed
transport, per-agent credentials and per-node or per-stack token narrowing are each
separate, reviewed work. They are not future flags in this version; they do not exist.
