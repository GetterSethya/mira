<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import { page } from "$app/state"
  import { goto } from "$app/navigation"
  import { mira } from "$lib/mira.js"
  import SpanWaterfall from "$lib/components/SpanWaterfall.svelte"
  import SpanWaterfallSkeleton from "$lib/components/SpanWaterfallSkeleton.svelte"
  import { Input } from "$lib/components/ui/input/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import { resolve } from "$app/paths"
  import { IconReload } from "@tabler/icons-svelte"

  const LIMIT = 200

  const initial = $derived(page.url.searchParams.get("traceId") ?? "")
  let traceIdFilter = $derived(initial)
  let committed = $derived(initial)
  let cursor = $state<number | null>(null)
  let cursorStack = $state<Array<number | null>>([])

  const spansQuery = createQuery(() => ({
    queryKey: ["spans", committed, cursor],
    queryFn: () =>
      committed
        ? mira.telemetry.getSpans({ traceId: committed }).raw()
        : mira.telemetry.getSpans({ limit: LIMIT, cursor }).raw()
  }))

  function apply() {
    committed = traceIdFilter
    cursor = null
    cursorStack = []
    if (committed) goto(resolve(`/spans?traceId=${committed}`), { replaceState: true })
    else goto(resolve(`/spans`), { replaceState: true })
  }

  function clear() {
    traceIdFilter = ""
    committed = ""
    cursor = null
    cursorStack = []
    goto(resolve(`/spans`), { replaceState: true })
  }
</script>

<div class="space-y-4">
  <div class="flex gap-2 items-center justify-between">
    <h1 class="text-2xl font-bold">Spans</h1>
    <Button class="ms-auto" variant="outline" onclick={spansQuery.refetch} disabled={spansQuery.isRefetching}>
      <IconReload class={spansQuery.isRefetching && "animate-spin"} />
    </Button>
  </div>

  <div class="flex gap-2">
    <Input
      placeholder="Filter by trace ID…"
      value={traceIdFilter}
      onkeydown={(e) => {
        if (e.key === "Enter") apply()
      }}
      class="max-w-sm"
    />
    <Button onclick={apply}>Filter</Button>
    {#if committed}
      <Button variant="outline" onclick={clear}>Clear</Button>
    {/if}
  </div>

  {#if spansQuery.isLoading}
    <SpanWaterfallSkeleton />
  {:else if spansQuery.data}
    {@const totalTraces = spansQuery.data.total}
    {@const nextCursor = spansQuery.data.nextCursor}
    <div class="flex justify-between items-center text-sm text-muted-foreground">
      <span>{totalTraces} total traces</span>
      {#if !committed}
        <div class="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={cursorStack.length === 0}
            onclick={() => {
              cursor = cursorStack.pop() ?? null
            }}>Previous</Button
          >
          <Button
            variant="outline"
            size="sm"
            disabled={nextCursor == null}
            onclick={() => {
              cursorStack.push(cursor)
              cursor = nextCursor
            }}>Next</Button
          >
        </div>
      {/if}
    </div>

    <SpanWaterfall spans={spansQuery.data.spans} />
  {/if}
</div>
