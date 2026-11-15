<script lang="ts">
  import Nav from '$lib/components/Nav.svelte';
  import NoticeBar from '$lib/components/NoticeBar.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import benchmarks from '$lib/benchmarks.json';

  const { results, environment, method, generatedAt } = benchmarks;

  const node = results.node;
  const bun = results.bun;

  const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

  const formatRate = (value: number) => `${number.format(value)} req/s`;
  const formatMs = (value: number) => `${decimal.format(value)} ms`;
  const formatDate = (value: string) =>
    new Date(value).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });

  if (
    node.runs.length !== bun.runs.length ||
    node.runs.length !== method.runs
  ) {
    throw new Error('Benchmark JSON has mismatched run counts');
  }

  const startup = node.startupMs / bun.startupMs;
  const startupFaster = startup - 1;
  const create = bun.create.throughput / node.create.throughput;
  const list = bun.list.throughput / node.list.throughput;
  const listCached = bun.listCached.throughput / node.listCached.throughput;
  const p50 = 1 - bun.list.p50 / node.list.p50;
  const cachedP50 = 1 - bun.listCached.p50 / node.listCached.p50;

  const values = (
    runs: ReadonlyArray<{
      startupMs: number;
      create: { throughput: number; p50: number; p95: number };
      list: { throughput: number; p50: number; p95: number };
      listCached: { throughput: number; p50: number; p95: number };
    }>,
    pick: (run: (typeof node.runs)[number]) => number
  ) => runs.map(pick);

  const range = (values: ReadonlyArray<number>) => ({
    min: Math.min(...values),
    max: Math.max(...values)
  });

  const formatRange = (
    values: ReadonlyArray<number>,
    format: (value: number) => string
  ) => `${format(range(values).min)}–${format(range(values).max)}`;

  const overlaps = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
    const left = range(a);
    const right = range(b);
    return left.max >= right.min && right.max >= left.min;
  };

  const bunWins = (
    nodeValues: ReadonlyArray<number>,
    bunValues: ReadonlyArray<number>,
    lowerIsBetter: boolean
  ) =>
    nodeValues.reduce((wins, value, index) => {
      const bunValue = bunValues[index];
      if (bunValue === undefined) return wins;
      const better = lowerIsBetter ? bunValue < value : bunValue > value;
      return wins + (better ? 1 : 0);
    }, 0);

  const verdict = (overlaps: boolean, wins: number) => {
    if (wins === method.runs && !overlaps) return 'Bun, clean separation';
    if (wins === method.runs) return 'Bun, consistent direction (magnitude uncertain)';
    if (wins === 0 && !overlaps) return 'Node, clean separation';
    if (wins === 0) return 'Node, consistent direction (magnitude uncertain)';
    if (overlaps) return `mixed (${wins}/${method.runs} Bun), ranges overlap`;
    return `mixed (${wins}/${method.runs} Bun), ranges separated`;
  };

  const nodeStartup = values(node.runs, (run) => run.startupMs);
  const bunStartup = values(bun.runs, (run) => run.startupMs);
  const nodeCreate = values(node.runs, (run) => run.create.throughput);
  const bunCreate = values(bun.runs, (run) => run.create.throughput);
  const nodeList = values(node.runs, (run) => run.list.throughput);
  const bunList = values(bun.runs, (run) => run.list.throughput);
  const nodeListCached = values(node.runs, (run) => run.listCached.throughput);
  const bunListCached = values(bun.runs, (run) => run.listCached.throughput);
  const nodeCreateP95 = values(node.runs, (run) => run.create.p95);
  const bunCreateP95 = values(bun.runs, (run) => run.create.p95);
  const nodeListP50 = values(node.runs, (run) => run.list.p50);
  const bunListP50 = values(bun.runs, (run) => run.list.p50);
  const nodeListP95 = values(node.runs, (run) => run.list.p95);
  const bunListP95 = values(bun.runs, (run) => run.list.p95);
  const nodeListCachedP50 = values(node.runs, (run) => run.listCached.p50);
  const bunListCachedP50 = values(bun.runs, (run) => run.listCached.p50);
  const nodeListCachedP95 = values(node.runs, (run) => run.listCached.p95);
  const bunListCachedP95 = values(bun.runs, (run) => run.listCached.p95);

  const createWins = bunWins(nodeCreate, bunCreate, false);
  const listWins = bunWins(nodeList, bunList, false);
  const listCachedWins = bunWins(nodeListCached, bunListCached, false);
  const p50Wins = bunWins(nodeListP50, bunListP50, true);
  const cachedP50Wins = bunWins(nodeListCachedP50, bunListCachedP50, true);

  const summary = [
    {
      label: 'Cold start · native TypeScript',
      node: `${formatMs(node.startupMs)} (${formatRange(nodeStartup, (v) => decimal.format(v))} ms)`,
      bun: `${formatMs(bun.startupMs)} (${formatRange(bunStartup, (v) => decimal.format(v))} ms)`,
      delta: startupFaster > 0
        ? `Bun ${decimal.format(startupFaster)}× faster`
        : `Node ${decimal.format(-startupFaster)}× faster`,
      note: 'Node 24 strips types at startup; Bun runs TypeScript natively. The bracket is spawn to first 200.'
    },
    {
      label: 'Create throughput',
      node: `${formatRate(node.create.throughput)} (${formatRange(nodeCreate, (v) => number.format(v))} req/s)`,
      bun: `${formatRate(bun.create.throughput)} (${formatRange(bunCreate, (v) => number.format(v))} req/s)`,
      delta: overlaps(nodeCreate, bunCreate)
        ? `mixed (${createWins}/${method.runs} Bun)`
        : `Bun ${decimal.format(create)}× Node`,
      note: overlaps(nodeCreate, bunCreate)
        ? 'Overlapping ranges mean the create gap is not separable at this sample size.'
        : `Bun faster in ${createWins}/${method.runs} pairs; ranges separated.`
    },
    {
      label: 'List throughput (uncached)',
      node: `${formatRate(node.list.throughput)} (${formatRange(nodeList, (v) => number.format(v))} req/s)`,
      bun: `${formatRate(bun.list.throughput)} (${formatRange(bunList, (v) => number.format(v))} req/s)`,
      delta: overlaps(nodeList, bunList)
        ? `mixed (${listWins}/${method.runs} Bun)`
        : `Bun ${decimal.format(list)}× Node`,
      note: 'Unique filter per request bypasses the in-memory list cache.'
    },
    {
      label: 'List throughput (cached)',
      node: `${formatRate(node.listCached.throughput)} (${formatRange(nodeListCached, (v) => number.format(v))} req/s)`,
      bun: `${formatRate(bun.listCached.throughput)} (${formatRange(bunListCached, (v) => number.format(v))} req/s)`,
      delta: overlaps(nodeListCached, bunListCached)
        ? `mixed (${listCachedWins}/${method.runs} Bun)`
        : `Bun ${decimal.format(listCached)}× Node`,
      note: 'Same URL repeated after a warm-up, so the in-memory list cache serves every measured request.'
    },
    {
      label: 'List p50 latency (uncached)',
      node: `${formatMs(node.list.p50)} (${formatRange(nodeListP50, (v) => decimal.format(v))} ms)`,
      bun: `${formatMs(bun.list.p50)} (${formatRange(bunListP50, (v) => decimal.format(v))} ms)`,
      delta: overlaps(nodeListP50, bunListP50)
        ? `mixed (${p50Wins}/${method.runs} Bun)`
        : `Bun ${Math.round(p50 * 100)}% lower`,
      note: 'Median of the five per-run p50s. At 50 in flight it includes queue time, not service time.'
    },
    {
      label: 'List p50 latency (cached)',
      node: `${formatMs(node.listCached.p50)} (${formatRange(nodeListCachedP50, (v) => decimal.format(v))} ms)`,
      bun: `${formatMs(bun.listCached.p50)} (${formatRange(bunListCachedP50, (v) => decimal.format(v))} ms)`,
      delta: overlaps(nodeListCachedP50, bunListCachedP50)
        ? `mixed (${cachedP50Wins}/${method.runs} Bun)`
        : `Bun ${Math.round(cachedP50 * 100)}% lower`,
      note: 'Cache-hit path; same URL repeated after warm-up.'
    }
  ];

  const throughput = [
    {
      label: 'Create',
      detail: `${method.createRequests} measured writes after ${method.seedRecords} seed writes, concurrency ${method.concurrency}`,
      node: node.create.throughput,
      bun: bun.create.throughput
    },
    {
      label: 'List (uncached)',
      detail: `${method.listRequests.toLocaleString('en-US')} unique-filter first-page reads, limit ${method.responseLimit}, concurrency ${method.concurrency}`,
      node: node.list.throughput,
      bun: bun.list.throughput
    },
    {
      label: 'List (cached)',
      detail: `${method.listRequests.toLocaleString('en-US')} repeated-URL first-page reads after warm-up, limit ${method.responseLimit}, concurrency ${method.concurrency}`,
      node: node.listCached.throughput,
      bun: bun.listCached.throughput
    }
  ];

  const latency = [
    { label: 'Create p50', node: node.create.p50, bun: bun.create.p50 },
    { label: 'Create p95', node: node.create.p95, bun: bun.create.p95 },
    { label: 'Create p99', node: node.create.p99, bun: bun.create.p99 },
    { label: 'List p50 (uncached)', node: node.list.p50, bun: bun.list.p50 },
    { label: 'List p95 (uncached)', node: node.list.p95, bun: bun.list.p95 },
    { label: 'List p99 (uncached)', node: node.list.p99, bun: bun.list.p99 },
    { label: 'List p50 (cached)', node: node.listCached.p50, bun: bun.listCached.p50 },
    { label: 'List p95 (cached)', node: node.listCached.p95, bun: bun.listCached.p95 },
    { label: 'List p99 (cached)', node: node.listCached.p99, bun: bun.listCached.p99 }
  ];

  const spread = [
    {
      label: 'Cold start',
      node: `${formatRange(nodeStartup, (v) => decimal.format(v))} ms`,
      bun: `${formatRange(bunStartup, (v) => decimal.format(v))} ms`,
      overlaps: overlaps(nodeStartup, bunStartup),
      wins: bunWins(nodeStartup, bunStartup, true)
    },
    {
      label: 'Create throughput',
      node: `${formatRange(nodeCreate, (v) => number.format(v))} req/s`,
      bun: `${formatRange(bunCreate, (v) => number.format(v))} req/s`,
      overlaps: overlaps(nodeCreate, bunCreate),
      wins: bunWins(nodeCreate, bunCreate, false)
    },
    {
      label: 'Create p95',
      node: `${formatRange(nodeCreateP95, (v) => decimal.format(v))} ms`,
      bun: `${formatRange(bunCreateP95, (v) => decimal.format(v))} ms`,
      overlaps: overlaps(nodeCreateP95, bunCreateP95),
      wins: bunWins(nodeCreateP95, bunCreateP95, true)
    },
    {
      label: 'List throughput (uncached)',
      node: `${formatRange(nodeList, (v) => number.format(v))} req/s`,
      bun: `${formatRange(bunList, (v) => number.format(v))} req/s`,
      overlaps: overlaps(nodeList, bunList),
      wins: bunWins(nodeList, bunList, false)
    },
    {
      label: 'List throughput (cached)',
      node: `${formatRange(nodeListCached, (v) => number.format(v))} req/s`,
      bun: `${formatRange(bunListCached, (v) => number.format(v))} req/s`,
      overlaps: overlaps(nodeListCached, bunListCached),
      wins: bunWins(nodeListCached, bunListCached, false)
    },
    {
      label: 'List p50 (uncached)',
      node: `${formatRange(nodeListP50, (v) => decimal.format(v))} ms`,
      bun: `${formatRange(bunListP50, (v) => decimal.format(v))} ms`,
      overlaps: overlaps(nodeListP50, bunListP50),
      wins: bunWins(nodeListP50, bunListP50, true)
    },
    {
      label: 'List p95 (uncached)',
      node: `${formatRange(nodeListP95, (v) => decimal.format(v))} ms`,
      bun: `${formatRange(bunListP95, (v) => decimal.format(v))} ms`,
      overlaps: overlaps(nodeListP95, bunListP95),
      wins: bunWins(nodeListP95, bunListP95, true)
    },
    {
      label: 'List p50 (cached)',
      node: `${formatRange(nodeListCachedP50, (v) => decimal.format(v))} ms`,
      bun: `${formatRange(bunListCachedP50, (v) => decimal.format(v))} ms`,
      overlaps: overlaps(nodeListCachedP50, bunListCachedP50),
      wins: bunWins(nodeListCachedP50, bunListCachedP50, true)
    },
    {
      label: 'List p95 (cached)',
      node: `${formatRange(nodeListCachedP95, (v) => decimal.format(v))} ms`,
      bun: `${formatRange(bunListCachedP95, (v) => decimal.format(v))} ms`,
      overlaps: overlaps(nodeListCachedP95, bunListCachedP95),
      wins: bunWins(nodeListCachedP95, bunListCachedP95, true)
    }
  ];

  const maxThroughput = Math.max(
    ...throughput.flatMap((metric) => [metric.node, metric.bun])
  );
</script>

<svelte:head>
  <title>Benchmarks — Node vs Bun — Mira</title>
  <meta
    name="description"
    content="A single-machine HTTP benchmark of the same Mira app on Node and Bun, with startup, create, uncached list, cached list and latency results plus run-to-run spread."
  />
</svelte:head>

<a class="skip" href="#main">Skip to content</a>

<div class="top-stack">
  <NoticeBar />
  <Nav />
</div>

<main id="main" class="benchmarks">
  <div class="container">
    <header class="hero">
      <p class="eyebrow">Benchmarks</p>
      <h1>Node vs Bun.<br />Same app, different runtime.</h1>
      <p class="lede">
        One Mira app, one SQLite-backed <code>posts</code> collection, one HTTP load
        generator. The server code is identical; the platform preset changes the runtime,
        HTTP server, TypeScript loader and SQLite driver. {method.runs} interleaved runs per
        runtime; medians and run ranges below.
      </p>
      <p class="stamp">
        Measured {formatDate(generatedAt)} · {environment.os} · {environment.cpu.trim()} · Node
        {environment.node} · Bun {environment.bun}
      </p>
    </header>

    <section class="summary" aria-label="Summary">
      {#each summary as item}
        <article class="summary-card">
          <p class="summary-label">{item.label}</p>
          <p class="summary-delta">{item.delta}</p>
          <dl>
            <div>
              <dt>Node</dt>
              <dd>{item.node}</dd>
            </div>
            <div class="bun">
              <dt>Bun</dt>
              <dd>{item.bun}</dd>
            </div>
          </dl>
          <p class="summary-note">{item.note}</p>
        </article>
      {/each}
    </section>
    <p class="summary-footnote">
      “Ranges overlap” means the best run on one runtime is not clearly separated from the
      worst run on the other; treat that metric as inconclusive.
    </p>

    <section class="section throughput-section">
      <div class="section-head">
        <p class="eyebrow">Throughput</p>
        <h2>Requests per second, higher is better.</h2>
        <p class="lede">
          The same generated REST routes and rule compiler run on both sides. The create
          benchmark includes validation, the public create rule, a WAL write and a list-cache
          invalidation. The uncached list benchmark sends a unique title filter per request so
          Mira's in-memory list cache cannot serve it. It is an unsorted first page: the query
          returns 30 rows, so the table size above 30 does not affect its cost; each miss still
          writes the page back to the cache. The cached list benchmark repeats one URL after a
          warm-up, so every measured read is served by the in-memory list cache.
        </p>
      </div>

      <div class="bars">
        {#each throughput as metric}
          <div class="bar-group">
            <div class="bar-head">
              <div>
                <h3>{metric.label}</h3>
                <p>{metric.detail}</p>
              </div>
              <span class="bar-scale">max {formatRate(maxThroughput)}</span>
            </div>
            <div class="bar-row">
              <span class="bar-name">Node</span>
              <div class="bar-track">
                <span
                  class="bar-fill node"
                  style:width={`${(metric.node / maxThroughput) * 100}%`}
                ></span>
              </div>
              <span class="bar-value">{formatRate(metric.node)}</span>
            </div>
            <div class="bar-row">
              <span class="bar-name">Bun</span>
              <div class="bar-track">
                <span
                  class="bar-fill bun"
                  style:width={`${(metric.bun / maxThroughput) * 100}%`}
                ></span>
              </div>
              <span class="bar-value">{formatRate(metric.bun)}</span>
            </div>
          </div>
        {/each}
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <p class="eyebrow">Latency</p>
        <h2>Percentiles, lower is better.</h2>
        <p class="lede">
          Each figure is measured with 50 requests in flight, so it includes time waiting for a
          worker slot: this is load-conditioned system latency, not single-request service time.
          The table shows the median of the five per-run p50/p95/p99 values; the spread table
          below shows the run-to-run range and paired wins.
        </p>
      </div>

      <!-- svelte-ignore a11y_no_noninteractive_tabindex — scrollable region; keyboard focus is intentional -->
      <div class="table-wrap" tabindex="0" role="region" aria-label="Latency medians">
        <table>
          <caption class="sr-only">Median latency per metric for Node and Bun</caption>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">Node median</th>
              <th scope="col">Bun median</th>
            </tr>
          </thead>
          <tbody>
            {#each latency as row}
              <tr>
                <th scope="row">{row.label}</th>
                <td>{formatMs(row.node)}</td>
                <td>{formatMs(row.bun)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="spread-wrap">
        <h3>Run-to-run spread</h3>
        <p>
          Minimum to maximum across the {method.runs} runs. “Bun wins” counts interleaved
          pairs where Bun was faster (higher throughput or lower latency); runs are paired by
          index. A clean separation means the ranges do not touch. Consistent direction with
          overlapping ranges means every pair favoured Bun but one outlier widened the range.
        </p>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex — scrollable region; keyboard focus is intentional -->
        <div class="table-wrap" tabindex="0" role="region" aria-label="Run-to-run spread">
          <table>
            <caption class="sr-only">Minimum and maximum values, Bun wins and verdict per metric</caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Node range</th>
                <th scope="col">Bun range</th>
                <th scope="col">Bun wins</th>
                <th scope="col">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {#each spread as row}
                <tr>
                  <th scope="row">{row.label}</th>
                  <td>{row.node}</td>
                  <td>{row.bun}</td>
                  <td>{row.wins}/{method.runs}</td>
                  <td class:inconclusive={row.overlaps}>
                    {verdict(row.overlaps, row.wins)}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <p class="eyebrow">Method</p>
        <h2>What is being measured.</h2>
      </div>

      <div class="method-grid">
        <dl class="facts">
          <div><dt>Runs</dt><dd>{method.runs} alternating pairs, median shown</dd></div>
          <div><dt>Records</dt><dd>{method.seedRecords} seed + {method.createRequests} measured creates ({number.format(method.records)} rows)</dd></div>
          <div><dt>List load</dt><dd>{number.format(method.listRequests)} uncached (unique-filter) + {number.format(method.listRequests)} cached (repeated-URL) requests</dd></div>
          <div><dt>List cache</dt><dd>{method.cache.enabled ? `enabled (${method.cache.listTtlMs} ms TTL)` : 'disabled'}</dd></div>
          <div><dt>Concurrency</dt><dd>{method.concurrency} measured; {method.seedConcurrency} seed / {method.warmupConcurrency} warm-up</dd></div>
          <div><dt>Request body</dt><dd>{method.payloadBytes}-byte <code>body</code> field on create</dd></div>
          <div><dt>Create batching</dt><dd>{method.batchMutation.create.enabled ? `enabled (${method.batchMutation.create.windowMs} ms window, max ${method.batchMutation.create.maxBatchSize})` : 'disabled'}</dd></div>
          <div><dt>List response</dt><dd>limit {method.responseLimit} rows</dd></div>
          <div><dt>Host</dt><dd>{environment.cores} threads · ~{environment.memoryGb} GB RAM</dd></div>
          <div><dt>Node TS</dt><dd>{method.nodeLoader === 'native' ? 'native type stripping' : 'tsx loader'}</dd></div>
          <div><dt>Bun TS</dt><dd>native loader</dd></div>
          <div><dt>Client</dt><dd>Same Node fetch process for both servers</dd></div>
        </dl>

        <div class="caveats">
          <p>
            This is a directional, single-machine comparison, not a universal claim. Both
            servers run the same Mira code, collections, rules, migrations and HTTP router.
            Console telemetry is disabled on both so span export does not compete with the
            request. Both run the TypeScript server directly: Node 24 strips types at startup,
            Bun uses its native loader. Bun uses Bun's native HTTP server, SQLite driver and
            runtime. Node uses <code>node:http</code>, <code>node:sqlite</code> and the Node
            platform preset. A compiled Node bundle would be a different experiment.
          </p>
          <p>
            Database files are fresh for every run, so startup includes migration. Each Node
            and Bun run is interleaved (Node, Bun, Node, Bun…) and the uncached list requests use a
            unique title filter so the in-memory list cache cannot serve them; each miss still
            writes the page back to the cache, so the number includes that write. The cached
            list repeats one URL after a warm-up and measures the cache-hit path. Five paired
            runs can reach a two-sided sign-test floor of p = 0.0625; this is not a
            significance claim. One concurrency point is not a capacity curve. The load
            generator is a small Node script with no external benchmark binary. Run it
            yourself:
          </p>
          <pre><code>pnpm benchmark:platforms</code></pre>
          <p class="not-measured">
            <strong>Not measured:</strong> auth and password hashing, uploads, updates/deletes,
            relations and <code>expand</code>, pagination past the first page, memory,
            multi-core scaling, any concurrency other than {method.concurrency}, any other
            machine, and a compiled Node bundle. Create writes are durable and I/O-bound, which
            makes create the noisiest metric.
          </p>
          <p class="source">
            <a
              href="https://github.com/GetterSethya/mira/tree/main/apps/benchmarks"
              target="_blank"
              rel="noreferrer">Methodology and source</a
            >
            ·
            <a
              href="https://github.com/GetterSethya/mira/blob/main/apps/landing/src/lib/benchmarks.json"
              target="_blank"
              rel="noreferrer">Raw per-run results</a
            >
            · Links point at the latest main; the raw file changes when the benchmark is rerun.
          </p>
        </div>
      </div>
    </section>
  </div>
</main>

<Footer />

<style>
  .top-stack {
    position: sticky;
    top: 0;
    z-index: 40;
  }

  .benchmarks {
    padding: 72px 0 96px;
  }

  .hero {
    max-width: 860px;
    margin-bottom: 48px;
  }

  .hero h1 {
    margin: 12px 0 20px;
    font-size: clamp(40px, 6.2vw, 72px);
    font-weight: 500;
    letter-spacing: var(--tracking-tight);
    line-height: var(--leading-tight);
  }

  .hero .lede {
    max-width: 72ch;
  }

  code {
    padding: 2px 5px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--code-bg);
    color: var(--code-fg);
    font-family: var(--font-mono);
    font-size: 0.92em;
  }

  .stamp {
    margin-top: 22px;
    color: var(--muted);
    font-size: var(--text-2xs);
    letter-spacing: 0.02em;
    line-height: 1.7;
  }

  .summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1px;
    margin-bottom: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--border);
    overflow: hidden;
  }

  .summary-card {
    padding: 20px;
    background: var(--surface);
  }

  .summary-label {
    color: var(--muted);
    font-size: var(--text-2xs);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .summary-delta {
    margin-top: 8px;
    color: var(--ink);
    font-size: var(--text-xl);
    font-weight: 500;
    letter-spacing: var(--tracking-tight);
  }

  .summary-card dl {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 16px;
  }

  .summary-card dl div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    font-size: var(--text-xs);
  }

  .summary-card dt {
    color: var(--muted);
  }

  .summary-card dd {
    margin: 0;
    color: var(--fg);
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .summary-card .bun dd {
    color: var(--ink);
    font-weight: 500;
  }

  .summary-note {
    margin-top: 12px;
    color: var(--muted);
    font-size: var(--text-2xs);
    line-height: 1.5;
  }

  .summary-footnote {
    margin-bottom: 8px;
    color: var(--muted);
    font-size: var(--text-xs);
    line-height: 1.6;
  }

  .throughput-section {
    padding-top: clamp(56px, 7vw, 88px);
  }

  .bars {
    display: flex;
    flex-direction: column;
    gap: 28px;
    margin-top: 36px;
  }

  .bar-group {
    padding: 22px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
  }

  .bar-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 18px;
  }

  .bar-head h3 {
    font-size: var(--text-lg);
  }

  .bar-head p {
    margin-top: 4px;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .bar-scale {
    color: var(--muted);
    font-size: var(--text-2xs);
    white-space: nowrap;
  }

  .bar-row {
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr) 96px;
    align-items: center;
    gap: 12px;
    min-height: 34px;
  }

  .bar-name {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .bar-track {
    height: 12px;
    border-radius: 3px;
    background: var(--code-bg);
    overflow: hidden;
  }

  .bar-fill {
    display: block;
    height: 100%;
    border-radius: 3px;
    transform-origin: left;
  }

  .bar-fill.node {
    background: var(--border-strong);
  }

  .bar-fill.bun {
    background: var(--ink);
  }

  .bar-value {
    color: var(--fg);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .table-wrap {
    margin-top: 32px;
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  th,
  td {
    padding: 12px 16px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  thead th {
    color: var(--muted);
    font-size: var(--text-2xs);
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    background: var(--surface);
  }

  tbody th {
    font-weight: 400;
    color: var(--fg);
  }

  tbody td {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  tbody tr:last-child th,
  tbody tr:last-child td {
    border-bottom: 0;
  }

  .spread-wrap {
    margin-top: 40px;
  }

  .spread-wrap h3 {
    font-size: var(--text-lg);
  }

  .spread-wrap > p {
    max-width: 64ch;
    margin-top: 6px;
    color: var(--muted);
    font-size: var(--text-xs);
    line-height: 1.7;
  }

  .spread-wrap .table-wrap {
    margin-top: 18px;
  }

  td.inconclusive {
    color: var(--muted);
    font-style: italic;
  }

  table {
    min-width: 620px;
  }

  .method-grid {
    display: grid;
    grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
    gap: 32px;
    margin-top: 32px;
  }

  .facts {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 0;
    border-top: 1px solid var(--border);
  }

  .facts div {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }

  .facts dt {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .facts dd {
    margin: 0;
    color: var(--fg);
    font-size: var(--text-xs);
    text-align: right;
  }

  .caveats {
    color: var(--muted);
    font-size: var(--text-sm);
    line-height: 1.7;
  }

  .caveats p + p {
    margin-top: 14px;
  }

  .caveats code {
    font-size: 0.9em;
  }

  .caveats pre {
    margin: 16px 0;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--code-bg);
    color: var(--code-fg);
    overflow-x: auto;
  }

  .source a {
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  @media (max-width: 900px) {
    .summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .method-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 639px) {
    .benchmarks {
      padding-top: 48px;
    }

    .summary {
      grid-template-columns: 1fr;
    }

    .bar-row {
      grid-template-columns: 38px minmax(0, 1fr);
    }

    .bar-value {
      grid-column: 2;
      text-align: left;
      margin-top: -6px;
    }

    .bar-head {
      flex-direction: column;
      gap: 8px;
    }
  }
</style>
