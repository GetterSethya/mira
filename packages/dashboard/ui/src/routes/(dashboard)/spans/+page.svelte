<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import { page } from "$app/state"
  import { goto } from "$app/navigation"
  import { mira } from "$lib/mira.js"
  import SpanWaterfall from "$lib/components/SpanWaterfall.svelte"
  import { Input } from "$lib/components/ui/input/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import { resolve } from "$app/paths"
  import { IconReload } from "@tabler/icons-svelte"

  const LIMIT = 200

  const initial = $derived(page.url.searchParams.get("traceId") ?? "")
  let traceIdFilter = $derived(initial)
  let committed = $derived(initial)
  let offset = $state(0)

  const spansQuery = createQuery(() => ({
    queryKey: ["spans", committed, offset],
    queryFn: () =>
      committed
        ? mira.telemetry.getSpans({ traceId: committed }).raw()
        : mira.telemetry.getSpans({ limit: LIMIT, offset }).raw()
  }))

  function apply() {
    committed = traceIdFilter
    offset = 0
    if (committed) goto(resolve(`/spans?traceId=${committed}`), { replaceState: true })
    else goto(resolve(`/spans`), { replaceState: true })
  }

  function clear() {
    traceIdFilter = ""
    committed = ""
    offset = 0
    goto(resolve(`/spans`), { replaceState: true })
  }
</script>

<div class="space-y-4">
  <div class="flex gap-2 items-center justify-between">
    <h1 class="text-2xl font-bold">Spans</h1>
    <Button class="ms-auto" variant="outline" onclick={spansQuery.refetch} disabled={spansQuery.isRefetching}>
      <IconReload class={spansQuery.isRefetching && "animate-spin"} />
    </Button>
    <Input
      placeholder="Filter by traceId…"
      value={traceIdFilter}
      oninput={(e) => (traceIdFilter = (e.target as HTMLInputElement).value)}
      onkeydown={(e) => {
        if (e.key === "Enter") apply()
      }}
      class="max-w-sm font-mono text-sm"
    />
    <Button variant="outline" onclick={apply}>Filter</Button>
    {#if committed}
      <Button variant="ghost" onclick={clear}>Clear</Button>
    {/if}
  </div>

  {#if spansQuery.isLoading}
    <p class="text-muted-foreground">Loading…</p>
  {:else if spansQuery.data}
    <SpanWaterfall spans={spansQuery.data.spans} />
    {@const data = spansQuery.data}
    {@const totalTraces = data.total}
    {@const pageStart = offset + 1}
    {@const pageEnd = Math.min(offset + LIMIT, totalTraces)}
    <div class="flex items-center justify-between text-xs text-muted-foreground">
      {#if committed}
        <span>{data.spans.length} spans in trace</span>
      {:else}
        <span>Traces {pageStart}–{pageEnd} of {totalTraces}</span>
        <div class="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onclick={() => (offset = Math.max(0, offset - LIMIT))}>Previous</Button
          >
          <Button
            variant="outline"
            size="sm"
            disabled={pageEnd >= totalTraces}
            onclick={() => (offset = offset + LIMIT)}>Next</Button
          >
        </div>
      {/if}
    </div>
  {/if}
</div>
