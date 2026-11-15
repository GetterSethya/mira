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
- `BENCH_CACHE=off` disables the collection cache; `list-hit` repeats the same URL to measure the cache-hit path.
- `BENCH_TRACING=on` re-enables tracing; `BENCH_STACK_TRACES=off` disables span stack capture.
- `AUDIT_INDEX_TITLE=1` adds a benchmark-only `posts_title_idx` index (see below).

## Bulk create: transactional batch vs individual creates

A focused evidence run for the transactional bulk-create endpoint:

```bash
pnpm --filter mira-benchmarks bulk-create:audit
```

It spawns the benchmark server with `BENCH_SYNCHRONOUS=FULL` and a throwaway database, then
compares 500 sequential `POST /api/collections/posts` requests with one
`POST /api/collections/posts/bulk` carrying the same 500 records. It is not part of the
published platform benchmark; it exists to show the cost of 500 commits versus one.

## Create batching: transparent single-create batching

A one-feature evidence run for the opt-in create batcher:

```bash
pnpm --filter mira-benchmarks create-batch:audit
AUDIT_FAST=1 pnpm --filter mira-benchmarks create-batch:audit   # reduced smoke run
```

The server enables batching with `.createBatch({ enabled, windowMs, maxBatchSize })`, driven by:

- `BENCH_CREATE_BATCH=off|on` (default `off`)
- `BENCH_CREATE_BATCH_WINDOW_MS` (default `0`)
- `BENCH_CREATE_BATCH_MAX` (default `100`)

The audit spawns four server configurations (`{FULL, NORMAL} × {off, on}`), each cell in a fresh
temporary directory and database, and reports:

- concurrency 1/10/50/100 with 200/1 000/5 000/5 000 measured creates per cell, 50 warm-ups, three
  repeats, medians and p50/p99;
- `/__bench/batch-stats` counters (`batches`, `commits`, `records`, `maxBatchSize`,
  `lastBatchSizes`, `rejected`, `consecutiveDefects`) reset after warm-up, so `commits / requests`
  is the real commit ratio and `records === requests` is checked;
- `/__bench/count` row-count checks (`rows === measured + warm-ups`);
- a concurrent read arm during each create cell (target: 500 completed reads; check 8 reports
  `insufficient-data` when a cell misses it), plus read-at-rest on the same database file;
- an open-loop arm at 600 and 1 200 req/s for 5 s with a 1 000 in-flight cap, measuring from the
  scheduled send time; runs that hit the cap are marked `capped` and excluded from check 9, and
  503s are split into `batch_unavailable` vs other failures;
- a window sweep (`0/1/2/5/10` ms) and a batch-size sweep (`25/50/100/200`) at c50;
- payload→response verification (each response's `title` must equal the title sent) and a
  success-rate gate. `rps` is successful (2xx) throughput; the success rate is reported alongside.

`AUDIT_OUT` selects the output directory; the raw JSON and a Markdown summary are written there.
The script exits non-zero when an acceptance criterion fails, so a failed experiment is not
mistaken for a pass.

**Windows timer granularity.** The default window is `0`, which drains what is already queued
after one scheduler yield and never sleeps. Positive windows use a real timer:
`Effect.sleep(2)` can take ~15.6 ms on Windows, so a positive window makes every sequential (c1)
create pay that cost. The window sweep starts at `0` for exactly this reason; read it before
choosing an operating point.

**Create retries can duplicate rows.** A request whose insert committed after the client timed out
never receives a response, and there is no idempotency key on the create route. Do not blindly
retry a create that returned `503 batch_unavailable` or timed out; the row may already exist.

## Selective filter: full scan vs title index

The list benchmark's filter is `title neq <value>`, which matches every seeded row, so
`LIMIT 30` stops the scan after the first 30 rows. That is the right shape for a cache/SQL
comparison, but it cannot show the cost of a scan that has to touch the whole table.

`list-scan` (`list-scan-large` in `profiles`, plus the `repo-list-scan` cases) uses
`title = <missing>` instead: the filter selects nothing, so `LIMIT 30` cannot stop early and
SQLite must read every row. That is a full table scan. `list-selective-fullscan`
(`list-selective-fullscan-large`, `list-selective-fullscan-50000-c50`) is the same probe under a
name that states the cost when no index exists. Every case result records `titleIndex: false`
unless `AUDIT_INDEX_TITLE=1` is set.

`AUDIT_INDEX_TITLE=1` creates `CREATE INDEX IF NOT EXISTS posts_title_idx ON posts(title)` in
the seeded database before the measured server starts, turning the same selective filter into
an index seek. The flag is written into the audit JSON as `method.titleIndex` and repeated per
case result, so an indexed run is never mistaken for an unindexed one:

```bash
AUDIT_MODE=load AUDIT_PLATFORMS=node AUDIT_ONLY=list-selective-fullscan-50000-c50 pnpm --filter mira-benchmarks perf:audit
AUDIT_MODE=load AUDIT_PLATFORMS=node AUDIT_ONLY=list-selective-fullscan-50000-c50 AUDIT_INDEX_TITLE=1 pnpm --filter mira-benchmarks perf:audit
```

The index is a benchmark-only control. It is created out-of-band on the seeded database and is
**not** part of the `posts` collection definition, so it is not a recommendation to index every
filterable column in a real app. Use the two runs together: unindexed tells you what a full scan
costs at this row count, indexed tells you the ceiling an index can buy back.

## Output

The generated JSON records the environment, method, per-run samples and aggregates. The page
shows startup, create/list throughput, latency percentiles and the min–max spread.
