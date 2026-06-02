<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import { client } from "$lib/client.js"
  import * as Table from "$lib/components/ui/table/index.js"
  import { Badge } from "$lib/components/ui/badge/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import * as Select from "$lib/components/ui/select/index.js"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"

  const LIMIT = 50
  let level = $state("")
  let offset = $state(0)

  const logsQuery = createQuery(() => ({
    queryKey: ["logs", level, offset],
    queryFn: () => client.logs({ limit: LIMIT, offset, level: level || undefined })
  }))

  const levelVariant = (l: string) => (l === "ERROR" ? "destructive" : l === "WARNING" ? "secondary" : "outline")

  const totalPages = $derived(logsQuery.data ? Math.ceil(logsQuery.data.total / LIMIT) : 0)
  const currentPage = $derived(Math.floor(offset / LIMIT) + 1)
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold">Logs</h1>
    <Select.Root
      type="single"
      value={level}
      onValueChange={(v) => {
        level = v
        offset = 0
      }}
    >
      <Select.Trigger class="w-36">
        {level || "All levels"}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="">All levels</Select.Item>
        <Select.Item value="INFO">INFO</Select.Item>
        <Select.Item value="WARNING">WARNING</Select.Item>
        <Select.Item value="ERROR">ERROR</Select.Item>
        <Select.Item value="DEBUG">DEBUG</Select.Item>
      </Select.Content>
    </Select.Root>
  </div>

  {#if logsQuery.isLoading}
    <p class="text-muted-foreground">Loading…</p>
  {:else if logsQuery.data}
    <div class="rounded-md border overflow-x-auto">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head class="w-20">Level</Table.Head>
            <Table.Head class="w-44">Timestamp</Table.Head>
            <Table.Head>Message</Table.Head>
            <Table.Head class="w-36">TraceId</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each logsQuery.data.logs as log (log.id)}
            <Table.Row>
              <Table.Cell>
                <Badge variant={levelVariant(log.level)} class="text-xs">{log.level}</Badge>
              </Table.Cell>
              <Table.Cell class="text-xs text-muted-foreground font-mono">
                {new Date(log.timestamp).toLocaleString()}
              </Table.Cell>
              <Table.Cell class="text-sm max-w-xl truncate">{log.message}</Table.Cell>
              <Table.Cell class="text-xs font-mono">
                {#if log.traceId}
                  <button
                    class="text-primary hover:underline truncate max-w-[120px] block"
                    onclick={() => goto(`${base}/spans?traceId=${log.traceId}`)}
                    title={log.traceId}
                  >
                    {log.traceId.slice(0, 12)}…
                  </button>
                {:else}
                  <span class="text-muted-foreground">—</span>
                {/if}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>

    <div class="flex items-center justify-between text-sm text-muted-foreground">
      <span>{logsQuery.data.total} total</span>
      <div class="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0}
          onclick={() => (offset = Math.max(0, offset - LIMIT))}
        >
          Prev
        </Button>
        <span class="px-2 py-1">Page {currentPage} of {totalPages}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={offset + LIMIT >= logsQuery.data.total}
          onclick={() => (offset += LIMIT)}
        >
          Next
        </Button>
      </div>
    </div>
  {/if}
</div>
