<script lang="ts">
  type Runtime = 'node' | 'bun';

  type MetricRow = {
    id: string;
    label: string;
    note: string;
    nodeText: string;
    bunText: string;
    nodeRange: string;
    bunRange: string;
    delta: string;
    winner: Runtime;
    nodeBar: number;
    bunBar: number;
  };

  let { row, index }: { row: MetricRow; index: number } = $props();
</script>

<article
  class="grid items-center gap-4 border-t border-[var(--border)] py-5 first:border-t-0 lg:grid-cols-[minmax(150px,0.75fr)_minmax(0,1.55fr)_minmax(150px,0.4fr)] lg:gap-7 max-lg:grid-cols-[minmax(0,1fr)_auto]"
>
  <div>
    <h3 class="text-[16px] font-semibold tracking-[-0.015em] text-[var(--ink)]">{row.label}</h3>
    <p class="mt-1 text-[14px] leading-[1.45] text-[var(--muted)]">{row.note}</p>
  </div>
  <div class="flex flex-col gap-2.5 max-lg:col-span-2">
    <div
      class="grid grid-cols-[44px_minmax(0,1fr)_auto] items-baseline gap-2.5 max-sm:grid-cols-[36px_minmax(0,1fr)_auto]"
    >
      <span
        class="text-[14px] font-medium {row.winner === 'node'
          ? 'text-[var(--ink)]'
          : 'text-[var(--muted)]'}">Node</span
      >
      <span
        class="text-[16px] tabular-nums {row.winner === 'node'
          ? 'text-[var(--success)]'
          : 'text-[var(--fg)]'}">{row.nodeText}</span
      >
      <span
        class="text-right text-[14px] tabular-nums text-[var(--muted)]"
        >{row.nodeRange}</span
      >
      <span class="col-[2/4] mt-0.5 h-1.5 overflow-hidden bg-[var(--code-bg)]">
        <span
          class="block h-full origin-left animate-[bar-in_640ms_var(--ease)_both] motion-reduce:animate-none {row.winner ===
          'node'
            ? 'bg-[var(--ink)]'
            : 'bg-[var(--muted)]'}"
          style:width={`${row.nodeBar}%`}
          style:animation-delay={`${index * 45}ms`}
        ></span>
      </span>
    </div>
    <div
      class="grid grid-cols-[44px_minmax(0,1fr)_auto] items-baseline gap-2.5 max-sm:grid-cols-[36px_minmax(0,1fr)_auto]"
    >
      <span
        class="text-[14px] font-medium {row.winner === 'bun'
          ? 'text-[var(--ink)]'
          : 'text-[var(--muted)]'}">Bun</span
      >
      <span
        class="text-[16px] tabular-nums {row.winner === 'bun'
          ? 'text-[var(--success)]'
          : 'text-[var(--fg)]'}">{row.bunText}</span
      >
      <span
        class="text-right text-[14px] tabular-nums text-[var(--muted)]"
        >{row.bunRange}</span
      >
      <span class="col-[2/4] mt-0.5 h-1.5 overflow-hidden bg-[var(--code-bg)]">
        <span
          class="block h-full origin-left animate-[bar-in_640ms_var(--ease)_both] motion-reduce:animate-none {row.winner ===
          'bun'
            ? 'bg-[var(--ink)]'
            : 'bg-[var(--muted)]'}"
          style:width={`${row.bunBar}%`}
          style:animation-delay={`${index * 45 + 90}ms`}
        ></span>
      </span>
    </div>
  </div>
  <p class="text-right text-[14px] font-medium leading-[1.35] text-[var(--fg)] max-lg:text-left">
    {row.delta}
  </p>
</article>
