<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import { mira } from "$lib/mira.js"
  import type { LogsResponse } from "$lib/dashboard-api.js"
  import { Badge } from "$lib/components/ui/badge/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import * as Select from "$lib/components/ui/select/index.js"
  import { goto } from "$app/navigation"
  import { page } from "$app/state"
  import AppDataTable from "$lib/components/ui/app-data-table/app-data-table.svelte"
  import TableSkeleton from "$lib/components/TableSkeleton.svelte"
  import type { ColumnDef } from "@tanstack/svelte-table"
  import { renderSnippet } from "$lib/components/ui/data-table"
  import { IconReload } from "@tabler/icons-svelte"

  const LIMIT = 50
  let level = $derived(page.url.searchParams.get("level") ?? "")
  let after = $derived(page.url.searchParams.get("after"))
  let cursor = $derived(after ? Number(after) : null)

  // Maintain a stack of previous cursors for back-navigation
  let cursorStack = $state<Array<number | null>>([])

  $effect(() => {
    // Reset cursor stack if level filter changes
    level
    cursorStack = []
  })

  const logsQuery = createQuery(() => ({
    queryKey: ["logs", level, cursor],
    queryFn: async () => {
      return mira.telemetry.getLogs({ limit: LIMIT, cursor }).raw()
    }
  }))

  const levelVariant = (l: string) => (l === "ERROR" ? "destructive" : l === "WARNING" ? "secondary" : "outline")

  const columns: ColumnDef<LogsResponse["logs"][number]>[] = [
    {
      accessorKey: "level",
      size: 1,
      cell: ({ row }) => renderSnippet(LevelCellSnippet, { level: row.original.level })
    },
    {
      accessorKey: "created",
      cell: ({ row }) => new Date(row.original.created).toLocaleString()
    },
    {
      accessorKey: "message",
      cell: ({ row }) => renderSnippet(MessageCellSnippet, { message: row.original.message })
    },
    {
      accessorKey: "traceId",
      cell: ({ row }) => renderSnippet(TraceIdCellSnippet, { traceId: row.original.traceId })
    }
  ]
</script>

{#snippet LevelCellSnippet({ level }: { level: string })}
  <Badge variant={levelVariant(level)}>{level}</Badge>
{/snippet}

{#snippet MessageCellSnippet({ message }: { message: string })}
  <span class="font-mono text-xs">{message}</span>
{/snippet}

{#snippet TraceIdCellSnippet({ traceId }: { traceId: string | null })}
  {#if traceId}
    <a href="/_dashboard/spans?traceId={traceId}" class="font-mono text-xs text-primary hover:underline">
      {traceId.slice(0, 8)}…
    </a>
  {:else}
    <span class="text-muted-foreground text-xs">—</span>
  {/if}
{/snippet}

<div class="space-y-4">
  <div class="flex gap-2 items-center justify-between">
    <h1 class="text-2xl font-bold">Logs</h1>
    <div class="flex items-center gap-2">
      <Select.Root
        type="single"
        value={level}
        onValueChange={(val) => {
          const searchParams = page.url.searchParams
          if (val === "ALL") {
            searchParams.delete("level")
          } else {
            searchParams.set("level", val)
          }
          searchParams.delete("after")
          goto(`?${searchParams.toString()}`)
        }}
      >
        <Select.Trigger class="w-32">
          {level ? level : "ALL"}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="ALL">All levels</Select.Item>
          <Select.Item value="DEBUG">DEBUG</Select.Item>
          <Select.Item value="INFO">INFO</Select.Item>
          <Select.Item value="WARNING">WARNING</Select.Item>
          <Select.Item value="ERROR">ERROR</Select.Item>
        </Select.Content>
      </Select.Root>
      <Button variant="outline" onclick={logsQuery.refetch} disabled={logsQuery.isRefetching}>
        <IconReload class={logsQuery.isRefetching && "animate-spin"} />
      </Button>
    </div>
  </div>

  {#if logsQuery.isLoading}
    <TableSkeleton />
  {:else if logsQuery.data}
    {@const nextCursor = logsQuery.data.nextCursor}
    <AppDataTable
      data={logsQuery.data.logs}
      {columns}
      pagination={false}
      pageCount={1}
      showSelectedRowCount={false}
      showPaginationInfo={false}
      manualPagination={true}
    >
      {#snippet footer()}
        <div class="flex justify-between items-center w-full">
          <span class="text-sm text-muted-foreground">{logsQuery.data.total} total log entries</span>
          <div class="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={cursorStack.length === 0}
              onclick={() => {
                const prev = cursorStack.pop()
                const searchParams = page.url.searchParams
                if (prev != null) {
                  searchParams.set("after", String(prev))
                } else {
                  searchParams.delete("after")
                }
                goto(`?${searchParams.toString()}`)
              }}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={nextCursor == null}
              onclick={() => {
                cursorStack.push(cursor)
                const searchParams = page.url.searchParams
                if (nextCursor != null) {
                  searchParams.set("after", String(nextCursor))
                }
                goto(`?${searchParams.toString()}`)
              }}
            >
              Next
            </Button>
          </div>
        </div>
      {/snippet}
    </AppDataTable>
  {/if}
</div>
