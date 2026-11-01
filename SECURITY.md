# Security policy

## Reporting a vulnerability

Report a suspected vulnerability privately through GitHub's security advisory flow on
this repository. Please do not open a public issue for a vulnerability.

Include the version, what you observed, and the smallest reproduction you can. You will
get an acknowledgement, and credit in the advisory if you want it.

## The threat model in one paragraph

`sencho-mcp` is a translator. It holds a Sencho API token with the Observe Only scope and
can reach exactly five read-only projection endpoints on the hub the operator configured.
The backend enforces that boundary; the adapter's own validation is defense in depth, not
the boundary. The adapter speaks stdio to a local client and makes no outbound request to
anything except `SENCHO_URL`.

## What the adapter does to stay narrow

- The token is read from a file when possible, sent only in the `Authorization` header,
  and never written into a tool result, an error, a log line or a URL.
- Every request path is a fixed template with, at most, a validated node id, stack name or
  page cursor encoded into it. No tool accepts a URL, path or method.
- Redirects are refused, not followed, so the token is never re-sent to a host the
  operator did not configure.
- Responses are capped at 1 MB and parsed with closed-enum schemas; unknown fields are
  dropped and an unrecognized enum value is a refusal.
- At most two requests are in flight, and a rate-limited request is retried once, honoring
  `Retry-After` up to five seconds.

## What it deliberately does not do

- No write, deploy, exec, log, file, env, secret or shell capability.
- No telemetry.
- No in-process HTTP transport. A network-exposed mode needs its own session, origin and
  authentication design and is out of scope.

## Supported versions

The latest release only until the project is past 0.x.
