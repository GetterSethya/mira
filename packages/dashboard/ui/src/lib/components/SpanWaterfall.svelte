<script lang="ts">
  import * as Tooltip from "$lib/components/ui/tooltip"
  import * as Table from "$lib/components/ui/table"
  import { SvelteSet } from "svelte/reactivity"
  import type { SpanRow } from "$lib/client.js"
  import { Badge } from "$lib/components/ui/badge/index.js"
  import { IconChevronDown, IconChevronRight, IconCopy } from "@tabler/icons-svelte"
  import { IconSize } from "$lib/constants"
  import { Button } from "./ui/button"
  import { toast } from "svelte-sonner"

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
      node.children.sort((a, b) => a.created.localeCompare(b.created))
      for (const c of node.children) setDepth(c, depth + 1)
    }
    for (const r of roots) setDepth(r, 0)
    return roots
  }

  function flatten(nodes: SpanNode[]): SpanNode[] {
    const result: SpanNode[] = []
    function visit(n: SpanNode) {
      result.push(n)
      for (const c of n.children) visit(c)
    }
    for (const n of nodes) visit(n)
    return result
  }

  const traceGroups = $derived(buildTraceGroups(spans))

  const sortedTraceGroup = $derived(
    [...traceGroups.entries()].sort((a, b) => {
      const aRoot = a[1].find((s) => s.parentSpanId === null) ?? a[1][0]
      const bRoot = b[1].find((s) => s.parentSpanId === null) ?? b[1][0]

      return bRoot.created.localeCompare(aRoot.created)
    })
  )

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
  {#each sortedTraceGroup as [traceId, traceSpans] (traceId)}
    {@const roots = buildTree(traceSpans)}
    {@const flatNodes = flatten(roots)}
    {@const rootDuration = roots[0]?.durationMs ?? 1}
    {@const isOpen = expanded.has(traceId)}
    {@const urlPath = roots[0]?.attributes?.["url.path"]}
    {@const statusCode = roots[0]?.attributes?.["http.response.status_code"]}
    {@const userIp = roots[0]?.attributes?.["client.address"]}
    {@const authCollection = roots[0]?.attributes?.["auth.collection"]}

    <div class="rounded-md border">
      <div class="flex flex-col w-full gap-3 px-4 py-2 text-left hover:bg-muted/50 font-mono text-xs">
        <div class="flex flex-1 items-center gap-3">
          <Button variant="ghost" onclick={() => toggleTrace(traceId)}>
            {#if isOpen}
              <IconChevronDown size={IconSize} />
            {:else}
              <IconChevronRight size={IconSize} />
            {/if}
          </Button>
          <span class="truncate text-muted-foreground" title={traceId}>{traceId.slice(0, 16)}…</span>
          <div>
            <span class="font-medium">{roots[0]?.name ?? "trace"}</span>
            {#if urlPath}
              <span class="font-medium">{urlPath}</span>
            {/if}
          </div>
          <span class="ml-auto text-muted-foreground"
            >{traceSpans.length} spans · {roots[0]?.durationMs.toFixed(1)}ms</span
          >
        </div>
        <div class="flex gap-3">
          <Badge variant="outline">{new Date(roots[0].created).toLocaleString()}</Badge>
          {#if statusCode}
            <Badge variant="outline">{`Status: ${statusCode}`}</Badge>
          {/if}
          {#if userIp}
            <Badge variant="outline">{`Ip: ${userIp}`}</Badge>
          {/if}
          {#if authCollection !== undefined}
            <Badge variant="outline">{`Auth: ${authCollection || "public"}`}</Badge>
          {/if}
        </div>
      </div>

      {#if isOpen}
        <div class="border-t">
          {#each flatNodes as node (node.spanId)}
            <div class="flex flex-col border-b last:border-b-0">
              <div class="flex items-center gap-2 px-4 py-1.5 text-xs" style="padding-left: {1 + node.depth * 1.25}rem">
                {#if Object.keys(node.attributes).length > 0}
                  <button
                    class="shrink-0 text-muted-foreground hover:text-foreground"
                    onclick={() => toggleSpan(node.spanId)}
                  >
                    {#if expandedSpans.has(node.spanId)}
                      <IconChevronDown size={IconSize} />
                    {:else}
                      <IconChevronRight size={IconSize} />
                    {/if}
                  </button>
                {/if}
                <span class="font-medium truncate max-w-[200px]">{node.name}</span>
                <Badge variant="outline" class="text-[10px] px-1 py-0">{node.kind}</Badge>
                {#if node.status === "error"}
                  <Badge variant="destructive" class="text-[10px] px-1 py-0">error</Badge>
                {:else}
                  <Badge variant="secondary" class="text-[10px] px-1 py-0">ok</Badge>
                {/if}
                <Tooltip.Provider>
                  <Tooltip.Root>
                    <Tooltip.Trigger
                      onclick={() => {
                        navigator.clipboard.writeText(JSON.stringify(node.attributes, null, 2))
                        toast.success("Span copied to clipboard")
                      }}
                    >
                      {#snippet child({ props })}
                        <Button size="icon" variant="outline" class="rounded-full" {...props}>
                          <IconCopy />
                        </Button>
                      {/snippet}
                    </Tooltip.Trigger>
                    <Tooltip.Content>
                      <p>Copy span to clipboard</p>
                    </Tooltip.Content>
                  </Tooltip.Root>
                </Tooltip.Provider>

                <span class="ml-auto text-muted-foreground shrink-0">{node.durationMs.toFixed(2)}ms</span>
                <div class="w-32 h-2 bg-muted rounded-full overflow-hidden shrink-0">
                  <div
                    class="h-full rounded-full {node.status === 'error' ? 'bg-destructive' : 'bg-primary'}"
                    style="width: {Math.min(100, (node.durationMs / rootDuration) * 100)}%"
                  ></div>
                </div>
              </div>
              {#if expandedSpans.has(node.spanId) && Object.keys(node.attributes).length > 0}
                <div
                  class="flex flex-wrap gap-x-3 gap-y-0.5 px-4 pb-1.5 text-[11px] font-mono"
                  style="padding-left: {1 + node.depth * 1.25}rem"
                >
                  <Table.Root>
                    <Table.Body>
                      {#each Object.entries(node.attributes) as [k, v]}
                        <Table.Row>
                          <Table.Cell class="font-bold">{k}</Table.Cell>
                          <Table.Cell>{v}</Table.Cell>
                        </Table.Row>
                      {/each}
                    </Table.Body>
                  </Table.Root>
                </div>
              {/if}
              {#if node.error}
                <div
                  class="px-4 pb-1.5 text-xs text-destructive font-mono"
                  style="padding-left: {1 + node.depth * 1.25}rem"
                >
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
