<script lang="ts">
  import Nav from '$lib/components/Nav.svelte';
  import NoticeBar from '$lib/components/NoticeBar.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import BenchmarkMetricRow from '$lib/components/BenchmarkMetricRow.svelte';
  import benchmarks from '$lib/benchmarks.json';

  const { results, environment, method, generatedAt } = benchmarks;

  const node = results.node;
  const bun = results.bun;

  const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });

  const formatRate = (value: number) => `${number.format(value)} req/s`;
  const formatMs = (value: number) => `${decimal.format(value)} ms`;
  const formatDate = (value: string) =>
    new Date(value).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });

  if (node.runs.length !== bun.runs.length || node.runs.length !== method.runs) {
    throw new Error('Benchmark JSON has mismatched run counts');
  }

  const values = (
    runs: ReadonlyArray<{
      startupMs: number;
      create: { throughput: number; p50: number; p95: number; p99: number };
      list: { throughput: number; p50: number; p95: number; p99: number };
      listCached: { throughput: number; p50: number; p95: number; p99: number };
    }>,
    pick: (run: (typeof node.runs)[number]) => number
  ) => runs.map(pick);

  const range = (values: ReadonlyArray<number>) => ({
    min: Math.min(...values),
    max: Math.max(...values)
  });

  const formatRange = (values: ReadonlyArray<number>, format: (value: number) => string) =>
    `${format(range(values).min)}–${format(range(values).max)}`;

  type Runtime = 'node' | 'bun';
  type MetricGroup = 'speed' | 'latency';

  type MetricRow = {
    id: string;
    group: MetricGroup;
    label: string;
    short: string;
    note: string;
    node: number;
    bun: number;
    lowerIsBetter: boolean;
    nodeText: string;
    bunText: string;
    nodeRange: string;
    bunRange: string;
    delta: string;
    winner: Runtime;
    nodeBar: number;
    bunBar: number;
  };

  const winnerOf = (nodeValue: number, bunValue: number, lowerIsBetter: boolean): Runtime => {
    if (lowerIsBetter) return bunValue <= nodeValue ? 'bun' : 'node';
    return bunValue >= nodeValue ? 'bun' : 'node';
  };

  const deltaOf = (
    nodeValue: number,
    bunValue: number,
    winner: Runtime,
    lowerIsBetter: boolean,
    kind: 'ratio' | 'percent'
  ) => {
    const winnerValue = winner === 'bun' ? bunValue : nodeValue;
    const loserValue = winner === 'bun' ? nodeValue : bunValue;
    const name = winner === 'bun' ? 'Bun' : 'Node';

    if (kind === 'percent') {
      return `${name} ${Math.round((1 - winnerValue / loserValue) * 100)}% lower`;
    }

    const factor = lowerIsBetter ? loserValue / winnerValue : winnerValue / loserValue;
    return `${name} ${decimal.format(factor)}×${lowerIsBetter ? ' faster startup' : ' throughput'}`;
  };

  const barWidth = (value: number, best: number, lowerIsBetter: boolean) =>
    lowerIsBetter ? (best / value) * 100 : (value / best) * 100;

  const makeRow = (spec: {
    id: string;
    group: MetricGroup;
    label: string;
    short: string;
    note: string;
    node: number;
    bun: number;
    lowerIsBetter: boolean;
    format: (value: number) => string;
    nodeRange: string;
    bunRange: string;
    deltaKind: 'ratio' | 'percent';
  }): MetricRow => {
    const winner = winnerOf(spec.node, spec.bun, spec.lowerIsBetter);
    const best = spec.lowerIsBetter
      ? Math.min(spec.node, spec.bun)
      : Math.max(spec.node, spec.bun);

    return {
      id: spec.id,
      group: spec.group,
      label: spec.label,
      short: spec.short,
      note: spec.note,
      node: spec.node,
      bun: spec.bun,
      lowerIsBetter: spec.lowerIsBetter,
      nodeText: spec.format(spec.node),
      bunText: spec.format(spec.bun),
      nodeRange: spec.nodeRange,
      bunRange: spec.bunRange,
      delta: deltaOf(spec.node, spec.bun, winner, spec.lowerIsBetter, spec.deltaKind),
      winner,
      nodeBar: barWidth(spec.node, best, spec.lowerIsBetter),
      bunBar: barWidth(spec.bun, best, spec.lowerIsBetter)
    };
  };

  const nodeStartup = values(node.runs, (run) => run.startupMs);
  const bunStartup = values(bun.runs, (run) => run.startupMs);
  const nodeCreate = values(node.runs, (run) => run.create.throughput);
  const bunCreate = values(bun.runs, (run) => run.create.throughput);
  const nodeList = values(node.runs, (run) => run.list.throughput);
  const bunList = values(bun.runs, (run) => run.list.throughput);
  const nodeListCached = values(node.runs, (run) => run.listCached.throughput);
  const bunListCached = values(bun.runs, (run) => run.listCached.throughput);
  const nodeListP50 = values(node.runs, (run) => run.list.p50);
  const bunListP50 = values(bun.runs, (run) => run.list.p50);
  const nodeListCachedP50 = values(node.runs, (run) => run.listCached.p50);
  const bunListCachedP50 = values(bun.runs, (run) => run.listCached.p50);

  const metricRows: ReadonlyArray<MetricRow> = [
    makeRow({
      id: 'startup',
      group: 'speed',
      label: 'Cold start',
      short: 'Cold start',
      note: 'spawn to first HTTP 200',
      node: node.startupMs,
      bun: bun.startupMs,
      lowerIsBetter: true,
      format: formatMs,
      nodeRange: formatRange(nodeStartup, (value) => decimal.format(value)),
      bunRange: formatRange(bunStartup, (value) => decimal.format(value)),
      deltaKind: 'ratio'
    }),
    makeRow({
      id: 'create',
      group: 'speed',
      label: 'Create',
      short: 'Create',
      note: '500 writes, coalesced',
      node: node.create.throughput,
      bun: bun.create.throughput,
      lowerIsBetter: false,
      format: formatRate,
      nodeRange: formatRange(nodeCreate, (value) => number.format(value)),
      bunRange: formatRange(bunCreate, (value) => number.format(value)),
      deltaKind: 'ratio'
    }),
    makeRow({
      id: 'list',
      group: 'speed',
      label: 'List, uncached',
      short: 'List',
      note: 'unique filter per request',
      node: node.list.throughput,
      bun: bun.list.throughput,
      lowerIsBetter: false,
      format: formatRate,
      nodeRange: formatRange(nodeList, (value) => number.format(value)),
      bunRange: formatRange(bunList, (value) => number.format(value)),
      deltaKind: 'ratio'
    }),
    makeRow({
      id: 'list-cached',
      group: 'speed',
      label: 'List, cached',
      short: 'Cached list',
      note: 'same URL after warm-up',
      node: node.listCached.throughput,
      bun: bun.listCached.throughput,
      lowerIsBetter: false,
      format: formatRate,
      nodeRange: formatRange(nodeListCached, (value) => number.format(value)),
      bunRange: formatRange(bunListCached, (value) => number.format(value)),
      deltaKind: 'ratio'
    }),
    makeRow({
      id: 'p50',
      group: 'latency',
      label: 'List p50, uncached',
      short: 'List p50',
      note: 'median of five p50s',
      node: node.list.p50,
      bun: bun.list.p50,
      lowerIsBetter: true,
      format: formatMs,
      nodeRange: formatRange(nodeListP50, (value) => decimal.format(value)),
      bunRange: formatRange(bunListP50, (value) => decimal.format(value)),
      deltaKind: 'percent'
    }),
    makeRow({
      id: 'p50-cached',
      group: 'latency',
      label: 'List p50, cached',
      short: 'Cached p50',
      note: 'cache hit',
      node: node.listCached.p50,
      bun: bun.listCached.p50,
      lowerIsBetter: true,
      format: formatMs,
      nodeRange: formatRange(nodeListCachedP50, (value) => decimal.format(value)),
      bunRange: formatRange(bunListCachedP50, (value) => decimal.format(value)),
      deltaKind: 'percent'
    })
  ];

  type Filter = 'all' | MetricGroup;
  let filter = $state<Filter>('all');

  const orderedRows = [
    ...metricRows.filter((row) => row.id !== 'startup'),
    ...metricRows.filter((row) => row.id === 'startup')
  ];
  const visibleRows = $derived(
    filter === 'all' ? orderedRows : orderedRows.filter((row) => row.group === filter)
  );
  const speedRows = $derived(visibleRows.filter((row) => row.group === 'speed'));
  const latencyMetricRows = $derived(visibleRows.filter((row) => row.group === 'latency'));

  type LatencyRow = {
    label: string;
    node: number;
    bun: number;
    winner: Runtime;
    nodeText: string;
    bunText: string;
    delta: string;
    shortDelta: string;
  };

  const latencyRows: ReadonlyArray<LatencyRow> = [
    { label: 'Create p50', node: node.create.p50, bun: bun.create.p50 },
    { label: 'Create p95', node: node.create.p95, bun: bun.create.p95 },
    { label: 'Create p99', node: node.create.p99, bun: bun.create.p99 },
    { label: 'List p50', node: node.list.p50, bun: bun.list.p50 },
    { label: 'List p95', node: node.list.p95, bun: bun.list.p95 },
    { label: 'List p99', node: node.list.p99, bun: bun.list.p99 },
    { label: 'Cached p50', node: node.listCached.p50, bun: bun.listCached.p50 },
    { label: 'Cached p95', node: node.listCached.p95, bun: bun.listCached.p95 },
    { label: 'Cached p99', node: node.listCached.p99, bun: bun.listCached.p99 }
  ].map((row) => {
    const winner = winnerOf(row.node, row.bun, true);
    const winnerValue = winner === 'bun' ? row.bun : row.node;
    const loserValue = winner === 'bun' ? row.node : row.bun;
    return {
      ...row,
      winner,
      nodeText: formatMs(row.node),
      bunText: formatMs(row.bun),
      delta: `${winner === 'bun' ? 'Bun' : 'Node'} ${Math.round((1 - winnerValue / loserValue) * 100)}% lower`,
      shortDelta: `${winner === 'bun' ? 'Bun' : 'Node'} ${Math.round((1 - winnerValue / loserValue) * 100)}%`
    };
  });

  const latencyGroups = ['Create', 'List', 'Cached'].map((label) => ({
    label,
    rows: latencyRows.filter((row) => row.label.startsWith(label))
  }));

  const workloadRows = orderedRows.filter((row) => row.group === 'speed');
  const cardRows = workloadRows;
  const workloadBunWins = workloadRows.filter((row) => row.winner === 'bun').length;
  const workloadNodeWins = workloadRows.length - workloadBunWins;
  const percentileBunWins = latencyRows.filter((row) => row.winner === 'bun').length;
  const percentileNodeWins = latencyRows.length - percentileBunWins;
  const leaderName = workloadBunWins >= workloadNodeWins ? 'Bun' : 'Node';
  const leaderWins = Math.max(workloadBunWins, workloadNodeWins);
  const percentileLeader = percentileBunWins >= percentileNodeWins ? 'Bun' : 'Node';
  const percentileLeaderWins = Math.max(percentileBunWins, percentileNodeWins);
  const workloadPhrase =
    leaderWins === workloadRows.length ? `all ${workloadRows.length}` : `${leaderWins} of ${workloadRows.length}`;
  const heroResult = `${leaderName} led ${workloadPhrase} headline metrics and ${percentileLeaderWins} of ${latencyRows.length} percentiles.`;
  const percentileExceptions = latencyRows.filter((row) => row.winner === 'node');
  const exceptionNote =
    percentileExceptions.length > 0
      ? `; ${percentileExceptions.map((row) => `${row.label}: Node is lower`).join('; ')}`
      : '';
  const verdictNote = `${percentileLeaderWins} of ${latencyRows.length} percentiles ${percentileLeader}${exceptionNote}.`;

  const facts = [
    { label: 'Runs', value: `${method.runs} interleaved pairs` },
    { label: 'Records', value: `${method.seedRecords} seed + ${method.createRequests} creates` },
    {
      label: 'List load',
      value: `${number.format(method.listRequests)} unique + ${number.format(method.listRequests)} repeated`
    },
    { label: 'Concurrency', value: `${method.concurrency} in flight` },
    { label: 'Host', value: `${environment.cores} threads · ~${environment.memoryGb} GB RAM` },
    { label: 'List cache', value: `${method.cache.listTtlMs / 1000} s TTL` },
    { label: 'Response limit', value: `${method.responseLimit} rows` },
    { label: 'Load generator', value: 'Node script' },
    { label: 'Create batching', value: 'enabled · 0 ms · 100 max' },
    { label: 'Telemetry', value: method.telemetry },
    {
      label: 'Node loader',
      value: method.nodeLoader === 'native' ? 'native type stripping' : 'tsx loader'
    },
    { label: 'Bun loader', value: 'native' }
  ] as const;

  const cpu = environment.cpu.trim().replace(' with Radeon Graphics', '');
  const osLabel = environment.os.startsWith('win32') ? 'Windows x64' : environment.os;
</script>

<svelte:head>
  <title>Node vs Bun benchmarks — Mira</title>
  <meta
    name="description"
    content="A single-machine Mira benchmark: the same TypeScript app and SQLite collection on Node 24 and Bun 1.4, with startup, create, list, cache and latency ranges."
  />
</svelte:head>

<a
  class="sr-only [font-family:var(--font-mono)] focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[100] focus:rounded-[var(--radius-sm)] focus:bg-[var(--ink)] focus:px-4 focus:py-2.5 focus:text-[14px] focus:text-[color:var(--bg)]!"
  href="#main">Skip to content</a
>

<div class="sticky top-0 z-40">
  <NoticeBar />
  <Nav />
</div>

<main
  id="main"
  class="mx-auto w-full max-w-[1200px] px-[var(--gutter)] pb-24 pt-14 [font-family:var(--font-mono)] text-[16px] leading-[1.6] text-[var(--fg)] max-sm:pt-10"
>
  <header class="grid items-start gap-10 pt-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)] lg:gap-16">
    <div class="animate-[rise_520ms_var(--ease)_both] motion-reduce:animate-none">
      <h1
        class="max-w-[12ch] text-[clamp(44px,6.2vw,78px)] font-semibold leading-[1.02] tracking-[-0.045em] text-[var(--ink)] max-sm:text-[44px]"
      >
        Node vs Bun, measured.
      </h1>
      <p class="mt-6 max-w-[52ch] text-[18px] leading-[1.6] text-[var(--fg)] max-sm:text-[18px]">
        One Mira app, one SQLite collection, one load generator. {heroResult}
      </p>
      <p class="mt-5 text-[14px] leading-[1.7] text-[var(--muted)]">
        <time datetime={generatedAt}>{formatDate(generatedAt)}</time> · {osLabel} · {cpu} · Node
        {environment.node} · Bun {environment.bun}
      </p>
      <div class="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-5">
        <a
          class="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--ink)] px-[18px] text-[14px] font-medium text-[color:var(--bg)]! transition-opacity hover:opacity-85"
          href="#result">See the numbers</a
        >
        <a
          class="text-[14px] font-medium text-[var(--ink)]! underline underline-offset-4"
          href="#method">Run it yourself</a
        >
      </div>
    </div>

    <aside
      class="w-full rounded-[var(--radius-md)] bg-[var(--surface)] p-6 animate-[rise_560ms_80ms_var(--ease)_both] motion-reduce:animate-none lg:max-w-[560px]"
      data-ui
      aria-label="Headline result"
    >
      <p class="text-[14px] font-medium text-[var(--muted)]">Headline metrics</p>
      <div class="mt-3.5 flex items-baseline gap-2">
        <span
          class="text-[54px] font-semibold leading-[0.9] tracking-[-0.05em] tabular-nums max-sm:text-[46px] {leaderWins > 0
            ? 'text-[var(--success)]'
            : 'text-[var(--muted)]'}">{leaderWins}</span
        >
        <span class="text-[24px] text-[var(--muted)]">of {workloadRows.length}</span>
        <span class="text-[14px] text-[var(--muted)]">{leaderName}</span>
      </div>
      <p class="mt-3.5 text-[14px] text-[var(--muted)]">{verdictNote}</p>
      <div
        class="mt-3 flex flex-wrap items-center gap-2"
        role="img"
        aria-label="Five interleaved pairs, alternating which runtime starts"
      >
        <span class="flex items-center gap-1 text-[14px] text-[var(--muted)]">
          <span class="block h-2 w-2 bg-[var(--border-strong)]"></span>N
        </span>
        <span class="flex items-center gap-1 text-[14px] text-[var(--muted)]">
          <span class="block h-2 w-2 bg-[var(--ink)]"></span>B
        </span>
        <span class="ml-1 flex items-center gap-0.5">
          {#each Array(10) as _, runIndex}
            <span
              class="block h-2 w-2 {runIndex % 4 === 0 || runIndex % 4 === 3
                ? 'bg-[var(--border-strong)]'
                : 'bg-[var(--ink)]'}"
            ></span>
          {/each}
        </span>
        <span class="ml-1 text-[14px] text-[var(--muted)]">5 pairs</span>
      </div>
      <ul class="mt-[18px] flex flex-col gap-1.5 border-t border-[var(--border)] pt-4 text-[14px] sm:grid sm:grid-cols-2 sm:gap-x-8 sm:gap-y-1.5 lg:flex lg:flex-col">
        {#each cardRows as row (row.id)}
          <li class="flex items-baseline justify-between gap-4">
            <span class="text-[var(--muted)]">{row.short}</span>
            <span class="text-right tabular-nums text-[var(--fg)]">{row.delta}</span>
          </li>
        {/each}
      </ul>
    </aside>
  </header>

  <section id="result" class="mt-24 scroll-mt-28">
    <div class="mb-7 flex flex-col items-start justify-between gap-5 lg:flex-row lg:items-end lg:gap-8">
      <div>
        <h2 class="animate-[rise_520ms_var(--ease)_both] text-[clamp(28px,3.4vw,42px)] font-semibold leading-[1.05] tracking-[-0.035em] text-[var(--ink)] motion-reduce:animate-none">
          The result.
        </h2>
        <p class="mt-2.5 max-w-[62ch] text-[18px] leading-[1.6] text-[var(--fg)]">
          Values are medians of five interleaved pairs; ranges are min–max. The table shows four headline metrics and two p50s; all six rows are separated. A full bar is the faster result.
        </p>
        <p class="mt-2 text-[14px] text-[var(--muted)]">
          Separation is descriptive; five pairs are not a significance claim.
        </p>
      </div>
      <div class="inline-flex flex-none gap-0.5 rounded-[var(--radius-sm)] bg-[var(--surface)] p-[3px]" role="group" aria-label="Filter metrics">
        <button
          type="button"
          class="min-h-[34px] rounded-[4px] border-0 px-3 text-[14px] font-medium transition-colors {filter ===
          'all'
            ? 'bg-[var(--code-bg)] text-[var(--ink)]!'
            : 'bg-transparent text-[var(--muted)]! hover:text-[var(--ink)]!'}"
          aria-pressed={filter === 'all'}
          onclick={() => (filter = 'all')}>All rows</button
        >
        <button
          type="button"
          class="min-h-[34px] rounded-[4px] border-0 px-3 text-[14px] font-medium transition-colors {filter ===
          'speed'
            ? 'bg-[var(--code-bg)] text-[var(--ink)]!'
            : 'bg-transparent text-[var(--muted)]! hover:text-[var(--ink)]!'}"
          aria-pressed={filter === 'speed'}
          onclick={() => (filter = 'speed')}>Speed</button
        >
        <button
          type="button"
          class="min-h-[34px] rounded-[4px] border-0 px-3 text-[14px] font-medium transition-colors {filter ===
          'latency'
            ? 'bg-[var(--code-bg)] text-[var(--ink)]!'
            : 'bg-transparent text-[var(--muted)]! hover:text-[var(--ink)]!'}"
          aria-pressed={filter === 'latency'}
          onclick={() => (filter = 'latency')}>p50s</button
        >
      </div>
    </div>

    <div class="rounded-[var(--radius-md)] bg-[var(--surface)] px-6 py-2 max-sm:px-4">
      {#if speedRows.length > 0}
        <div data-ui>
          {#each speedRows as row, index (row.id)}
            <BenchmarkMetricRow {row} {index} />
          {/each}
        </div>
      {/if}
      {#if latencyMetricRows.length > 0}
        <div
          class="border-[var(--border)] {speedRows.length > 0 ? 'border-t' : ''}"
          data-ui
        >
          {#each latencyMetricRows as row, index (row.id)}
            <BenchmarkMetricRow {row} {index} />
          {/each}
        </div>
      {/if}
    </div>
  </section>

  <section id="latency" class="mt-24 scroll-mt-28">
    <div class="mb-7">
      <h2 class="animate-[rise_520ms_var(--ease)_both] text-[clamp(28px,3.4vw,42px)] font-semibold leading-[1.05] tracking-[-0.035em] text-[var(--ink)] motion-reduce:animate-none">
        Latency.
      </h2>
      <p class="mt-2.5 max-w-[62ch] text-[18px] leading-[1.6] text-[var(--fg)]">
        Lower is better. Medians of five interleaved pairs; per-run ranges are in the raw JSON.
        Some percentile ranges overlap; read those medians as direction, not separation. Fifty
        requests in flight, so each row includes queue time, not single-request service time.
      </p>
    </div>

    <div class="rounded-[var(--radius-md)] bg-[var(--surface)] px-4 py-2 max-sm:px-2" data-ui>
      <div class="hidden sm:block">
        <table class="w-full border-collapse text-[14px]">
          <caption class="sr-only">Latency percentiles for Node and Bun</caption>
          <thead>
            <tr>
              <th class="border-b border-[var(--border)] px-2 py-3 text-left text-[14px] font-medium text-[var(--muted)]" scope="col">Metric</th>
              <th class="border-b border-[var(--border)] px-2 py-3 text-left text-[14px] font-medium text-[var(--muted)]" scope="col">Node</th>
              <th class="border-b border-[var(--border)] px-2 py-3 text-left text-[14px] font-medium text-[var(--muted)]" scope="col">Bun</th>
              <th class="border-b border-[var(--border)] px-2 py-3 text-right text-[14px] font-medium text-[var(--muted)]" scope="col">Gap</th>
            </tr>
          </thead>
          <tbody>
            {#each latencyRows as row (row.label)}
              <tr>
                <th class="border-b border-[var(--border)] px-2 py-3 text-left font-medium text-[var(--fg)] tabular-nums" scope="row">{row.label}</th>
                <td
                  class="border-b border-[var(--border)] px-2 py-3 text-left tabular-nums {row.winner ===
                  'node'
                    ? 'font-medium text-[var(--success)]'
                    : 'text-[var(--fg)]'}">{row.nodeText}</td
                >
                <td
                  class="border-b border-[var(--border)] px-2 py-3 text-left tabular-nums {row.winner ===
                  'bun'
                    ? 'font-medium text-[var(--success)]'
                    : 'text-[var(--fg)]'}">{row.bunText}</td
                >
                <td class="border-b border-[var(--border)] px-2 py-3 text-right text-[var(--muted)]">{row.delta}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="sm:hidden">
        {#each latencyGroups as group (group.label)}
          <div class="border-b border-[var(--border)] py-3 last:border-b-0">
            <p class="text-[14px] font-medium text-[var(--ink)]">{group.label}</p>
            <div
              class="mt-1 grid grid-cols-[32px_1fr_1fr_auto] items-baseline gap-x-3 gap-y-1 text-[13px]"
            >
              <span></span>
              <span class="text-right text-[var(--muted)]">Node</span>
              <span class="text-right text-[var(--muted)]">Bun</span>
              <span class="border-l border-[var(--border)] pl-3 text-right text-[var(--muted)]">Gap</span>
              {#each group.rows as row}
                <span class="text-[var(--muted)]">{row.label.slice(group.label.length + 1)}</span>
                <span
                  class="text-right tabular-nums {row.winner === 'node'
                    ? 'font-medium text-[var(--success)]'
                    : 'text-[var(--fg)]'}">{row.nodeText}</span
                >
                <span
                  class="text-right tabular-nums {row.winner === 'bun'
                    ? 'font-medium text-[var(--success)]'
                    : 'text-[var(--fg)]'}">{row.bunText}</span
                >
                <span class="border-l border-[var(--border)] pl-3 text-right text-[var(--muted)]">· {row.shortDelta}</span>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </section>

  <section id="method" class="mt-24 scroll-mt-28">
    <div class="mb-7">
      <h2 class="animate-[rise_520ms_var(--ease)_both] text-[clamp(28px,3.4vw,42px)] font-semibold leading-[1.05] tracking-[-0.035em] text-[var(--ink)] motion-reduce:animate-none">
        The method.
      </h2>
      <p class="mt-2.5 max-w-[62ch] text-[18px] leading-[1.6] text-[var(--fg)]">
        One machine, one app, five interleaved pairs. Both runtimes use the same Mira code,
        collections, rules and HTTP router. The difference is the runtime stack: platform preset,
        SQLite driver and TypeScript loader.
      </p>
    </div>

    <dl class="grid grid-cols-1 gap-x-12 border-y border-[var(--border)] lg:grid-cols-2" data-ui>
      {#each facts as fact}
        <div class="flex items-baseline justify-between gap-5 border-b border-[var(--border)] py-2.5">
          <dt class="shrink-0 whitespace-nowrap text-[14px] text-[var(--muted)]">{fact.label}</dt>
          <dd class="text-right text-[14px] text-[var(--fg)]">{fact.value}</dd>
        </div>
      {/each}
    </dl>

    <p class="mt-4 text-[14px] text-[var(--muted)]">
      Run it yourself:
      <code class="rounded-[3px] bg-[var(--code-bg)] px-1 py-px [font-family:var(--font-mono)] text-[0.92em] text-[var(--code-fg)]">pnpm benchmark:platforms</code>
    </p>

    <p class="mt-5 max-w-[68ch] text-[16px] leading-[1.6] text-[var(--fg)]">
      <strong class="font-semibold">Not measured:</strong> auth, uploads, updates/deletes, relations/expand,
      pagination past page one, memory, multi-core scaling, other concurrency, other machines,
      other operating systems, client saturation, and a compiled Node bundle.
    </p>

    <details class="mt-7 max-w-[68ch]">
      <summary class="cursor-pointer text-[16px] font-medium text-[var(--ink)]"
        >Full method, caveats and source</summary
      >
      <div class="mt-4 text-[16px] leading-[1.65] text-[var(--fg)] [&>p+p]:mt-3.5">
        <p>
          This is a directional, single-machine comparison, not a universal claim. Both servers
          run the same Mira code. Console telemetry is off on both. Node 24 strips types at
          startup; Bun uses its native loader. Bun uses its native HTTP server, SQLite driver and
          runtime. Node uses
          <code class="rounded-[3px] bg-[var(--code-bg)] px-1 py-px [font-family:var(--font-mono)] text-[0.92em] text-[var(--code-fg)]"
            >node:http</code
          >,
          <code class="rounded-[3px] bg-[var(--code-bg)] px-1 py-px [font-family:var(--font-mono)] text-[0.92em] text-[var(--code-fg)]"
            >node:sqlite</code
          >
          (under active development in Node 24) and the Node platform preset. A compiled Node bundle would be a different experiment.
          The load generator is a small Node script; no external benchmark binary is used. It
          runs on the same machine and was not separately benchmarked for saturation.
        </p>
        <p>
          Database files are fresh for every run, so startup includes migration. Startup ends at
          the first successful
          <code class="rounded-[3px] bg-[var(--code-bg)] px-1 py-px [font-family:var(--font-mono)] text-[0.92em] text-[var(--code-fg)]"
            >GET /api/collections/posts?limit=1</code
          >
          (HTTP 200). Runs alternate Node-first and Bun-first (Node, Bun, Bun, Node…). Create batching is enabled
          with a 0 ms window and a 100-write cap; concurrent single-record writes coalesce into a
          SQL batch, bounded by the 50 requests in flight. Five interleaved pairs can reach a
          two-sided sign-test
          floor of p = 0.0625; this is not a significance claim. One concurrency point is not a
          capacity curve. Create writes are durable and I/O-bound, which makes create the noisiest
          metric.
        </p>
        <p class="text-[14px] text-[var(--muted)]">
          <a
            class="text-[var(--ink)]! underline underline-offset-2"
            href="https://github.com/GetterSethya/mira/tree/main/apps/benchmarks"
            target="_blank"
            rel="noreferrer">Methodology and source</a
          >
          ·
          <a
            class="text-[var(--ink)]! underline underline-offset-2"
            href="https://github.com/GetterSethya/mira/blob/main/apps/landing/src/lib/benchmarks.json"
            target="_blank"
            rel="noreferrer">Raw per-run results</a
          >
          · Links point at the latest main; the raw file changes when the benchmark is rerun.
        </p>
      </div>
    </details>
  </section>
</main>

<Footer />
