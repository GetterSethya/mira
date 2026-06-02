<script lang="ts">
  import { SvelteSet } from "svelte/reactivity"
  import type { SpanRow } from "$lib/client.js"
  import { Badge } from "$lib/components/ui/badge/index.js"

  const { spans }: { spans: SpanRow[] } = $props()

  type SpanNode = SpanRow & { children: SpanNode[]; depth: number }

  function buildTraceGroups(spans: SpanRow[]) {
    const byTrace = new Map<string, SpanRow[]>()
    for (const s of spans) {
      const g = byTrace.get(s.traceId) ?? []
      g.push(s)
      byTrace.set(s.traceId, g)
    }
    return byTrace
  }

  function buildTree(traceSpans: SpanRow[]): SpanNode[] {
    const byId = new Map<string, SpanNode>()
    for (const s of traceSpans) {
      byId.set(s.spanId, { ...s, children: [], depth: 0 })
    }
    const roots: SpanNode[] = []
    for (const node of byId.values()) {
      if (node.parentSpanId && byId.has(node.parentSpanId)) {
        byId.get(node.parentSpanId)?.children.push(node)
      } else {
        roots.push(node)
      }
    }
    function setDepth(node: SpanNode, depth: number) {
      node.depth = depth
      node.children.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      for (const c of node.children) setDepth(c, depth + 1)
    }
    for (const r of roots) setDepth(r, 0)
    return roots
  }

  function flatten(nodes: SpanNode[]): SpanNode[] {
    const result: SpanNode[] = []
    function visit(n: SpanNode) { result.push(n); for (const c of n.children) visit(c) }
    for (const n of nodes) visit(n)
    return result
  }

  const traceGroups = $derived(buildTraceGroups(spans))
  const expanded = new SvelteSet<string>()
  function toggleTrace(id: string) {
    if (expanded.has(id)) expanded.delete(id)
    else expanded.add(id)
  }

  const expandedSpans = new SvelteSet<string>()
  function toggleSpan(spanId: string) {
    if (expandedSpans.has(spanId)) expandedSpans.delete(spanId)
    else expandedSpans.add(spanId)
  }
</script>

<div class="flex flex-col gap-4">
  {#each traceGroups as [traceId, traceSpans] (traceId)}
    {@const roots = buildTree(traceSpans)}
    {@const flatNodes = flatten(roots)}
    {@const rootDuration = roots[0]?.durationMs ?? 1}
    {@const isOpen = expanded.has(traceId)}

    <div class="rounded-md border">
      <button
        class="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-muted/50 font-mono text-xs"
        onclick={() => toggleTrace(traceId)}
      >
        <span class="text-muted-foreground">{isOpen ? "▼" : "▶"}</span>
        <span class="truncate text-muted-foreground" title={traceId}>{traceId.slice(0, 16)}…</span>
        <span class="font-medium">{roots[0]?.name ?? "trace"}</span>
        <span class="ml-auto text-muted-foreground">{traceSpans.length} spans · {roots[0]?.durationMs.toFixed(1)}ms</span>
      </button>

      {#if isOpen}
        <div class="border-t">
          {#each flatNodes as node (node.spanId)}
            <div class="flex flex-col border-b last:border-b-0">
              <div
                class="flex items-center gap-2 px-4 py-1.5 text-xs"
                style="padding-left: {1 + node.depth * 1.25}rem"
              >
                {#if Object.keys(node.attributes).length > 0}
                  <button
                    class="shrink-0 text-muted-foreground hover:text-foreground"
                    onclick={() => toggleSpan(node.spanId)}
                  >{expandedSpans.has(node.spanId) ? "▼" : "▶"}</button>
                {/if}
                <span class="font-medium truncate max-w-[200px]">{node.name}</span>
                <Badge variant="outline" class="text-[10px] px-1 py-0">{node.kind}</Badge>
                {#if node.status === "error"}
                  <Badge variant="destructive" class="text-[10px] px-1 py-0">error</Badge>
                {:else}
                  <Badge variant="secondary" class="text-[10px] px-1 py-0">ok</Badge>
                {/if}
                <span class="ml-auto text-muted-foreground shrink-0">{node.durationMs.toFixed(2)}ms</span>
                <div class="w-32 h-2 bg-muted rounded-full overflow-hidden shrink-0">
                  <div
                    class="h-full rounded-full {node.status === 'error' ? 'bg-destructive' : 'bg-primary'}"
                    style="width: {Math.min(100, (node.durationMs / rootDuration) * 100)}%"
                  ></div>
                </div>
              </div>
              {#if expandedSpans.has(node.spanId) && Object.keys(node.attributes).length > 0}
                <div class="flex flex-wrap gap-x-3 gap-y-0.5 px-4 pb-1.5 text-[11px] font-mono text-muted-foreground" style="padding-left: {1 + node.depth * 1.25}rem">
                  {#each Object.entries(node.attributes) as [k, v]}
                    <span><span class="text-foreground">{k}</span>=<span>{String(v)}</span></span>
                  {/each}
                </div>
              {/if}
              {#if node.error}
                <div class="px-4 pb-1.5 text-xs text-destructive font-mono" style="padding-left: {1 + node.depth * 1.25}rem">
                  {node.error}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
  {#if spans.length === 0}
    <p class="text-center text-muted-foreground py-8 text-sm">No spans found.</p>
  {/if}
</div>
