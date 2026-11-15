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
- Both servers execute TypeScript. Node uses `tsx`; Bun runs TypeScript natively. This is
  intentional because it matches each runtime's normal development path, but it makes the
  startup number a tooling comparison as well as a runtime comparison. A compiled Node bundle
  would be a different experiment.
- The load generator is the same Node `fetch` process for both servers. It does not use an
  external benchmark binary, so client-side variance is shared. The child process pipes are
  drained by the runner; no server output is left to block on.
- Fresh database per run means startup includes migration. Results are medians of five runs on
  one machine; the JSON keeps every run so the page can show overlap. They are directional,
  not a universal guarantee.
- The create metric includes a durable SQLite write and is expected to be fsync-bound. It is
  less separable than the list metric at this sample size; the page says so when the ranges
  overlap.

## Output

The generated JSON records the environment, method, per-run samples and aggregates. The page
shows startup, create/list throughput, latency percentiles and the min–max spread.
