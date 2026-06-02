<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import { page } from "$app/stores"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { client } from "$lib/client.js"
  import SpanWaterfall from "$lib/components/SpanWaterfall.svelte"
  import { Input } from "$lib/components/ui/input/index.js"
  import { Button } from "$lib/components/ui/button/index.js"

  const initial = $page.url.searchParams.get("traceId") ?? ""
  let traceIdFilter = $state(initial)
  let committed = $state(initial)

  const spansQuery = createQuery(() => ({
    queryKey: ["spans", committed],
    queryFn: () =>
      committed
        ? client.spans({ traceId: committed })
        : client.spans({ limit: 100 }),
  }))

  function apply() {
    committed = traceIdFilter
    if (committed) goto(`${base}/spans?traceId=${committed}`, { replaceState: true })
    else goto(`${base}/spans`, { replaceState: true })
  }

  function clear() {
    traceIdFilter = ""
    committed = ""
    goto(`${base}/spans`, { replaceState: true })
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold">Spans</h1>
  </div>

  <div class="flex gap-2">
    <Input
      placeholder="Filter by traceId…"
      value={traceIdFilter}
      oninput={(e) => (traceIdFilter = (e.target as HTMLInputElement).value)}
      onkeydown={(e) => { if (e.key === "Enter") apply() }}
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
    <p class="text-xs text-muted-foreground">{spansQuery.data.total} total spans</p>
  {/if}
</div>
