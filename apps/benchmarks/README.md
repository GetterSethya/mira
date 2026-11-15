# Mira platform benchmarks

Compares the same Mira app on the Node and Bun platforms.

```bash
pnpm benchmark:platforms
```

The runner starts each server in a fresh temporary directory, waits for the first `200`, then
runs the same HTTP load against both. Node and Bun runs are interleaved (Node, Bun, Node, Bun…)
to reduce drift from machine state.

| Stage | Load |
|---|---|
| Seed | 50 JSON `POST`s, concurrency 10 |
| Create | 500 measured JSON `POST`s, concurrency 50, 180-byte `body` |
| List warm-up | 100 unique-filter requests, concurrency 10 |
| List | 2,000 unique-filter `GET`s over 550 rows, `limit=30`, concurrency 50 |

Before measuring, the runner issues one filtered list request and asserts the response has 30
items. That catches a broken filter or an empty table before the load starts.

The list requests use a different `title neq <value>` filter on every request. That is
deliberate: Mira caches list responses for 10 seconds by default, and a repeated URL would
measure the cache, not SQLite. The unique filter forces a cache miss and runs the normal
generated list query. Each miss also writes the result back to the list cache, so the metric
includes that write; it is not a pure SQLite read.

It repeats the whole sequence five times per runtime and writes medians to
`apps/landing/src/lib/benchmarks.json`. The landing `/benchmarks` page renders that file,
including the per-run spread.

## Fairness boundaries

- The server code, collection definition, rules, migrations and router are the same. Only the
  platform preset and SQLite driver differ.
- Console telemetry is disabled with `Layer.empty` on both servers so span export does not
  compete with the request path.
- Node runs `node:http` + `node:sqlite`; Bun runs Bun's native HTTP server + `bun:sqlite`.
- Both servers execute TypeScript directly. Node 24 has type stripping enabled by default, so
  the runner starts it as `node src/server.ts`; Bun uses its native loader. Node's stripping is
  erasable-syntax only: no enums, namespaces, parameter properties or path-alias resolution
  unless you add `--experimental-transform-types` or a loader. This server uses erasable syntax
  and package imports, so it runs unchanged. A compiled Node bundle would be a different
  experiment.
- `BENCH_NODE_LOADER=tsx pnpm benchmark:platforms` restores the old `tsx` loader for a
  tooling comparison. Node 24 has no `--strip-types` flag; the older opt-in flag is
  `--experimental-strip-types`, and the default can be disabled with
  `--no-experimental-strip-types`.
- The load generator is the same Node `fetch` process for both servers. It does not use an
  external benchmark binary, so client-side variance is shared. The child process pipes are
  drained by the runner; no server output is left to block on.
- Fresh database per run means startup includes migration. Results are medians of five runs on
  one machine; the JSON keeps every run so the page can show overlap. They are directional,
  not a universal guarantee.
- The create metric includes a durable SQLite write and is expected to be fsync-bound. It is
  the noisiest metric; the page shows ranges and only calls a separation when the ranges do not
  overlap.

## Profiling audit

The audit harness runs a load curve and CPU-profile matrix with the same server:

```bash
AUDIT_MODE=profiles pnpm --filter mira-benchmarks perf:audit
AUDIT_MODE=load     pnpm --filter mira-benchmarks perf:audit
pnpm --filter mira-benchmarks perf:analyze .egm/perf-audit-2026-11-15
```

Useful controls:

- `AUDIT_ONLY=list-small,create` selects cases.
- `AUDIT_PLATFORMS=node` runs one platform.
- `AUDIT_OUT=<dir>` writes results elsewhere.
- `BENCH_SYNCHRONOUS=NORMAL` tests the SQLite durability trade-off.
- `BENCH_TRACING=on` re-enables tracing; `BENCH_STACK_TRACES=off` disables span stack capture.

## Output

The generated JSON records the environment, method, per-run samples and aggregates. The page
shows startup, create/list throughput, latency percentiles and the min–max spread.
