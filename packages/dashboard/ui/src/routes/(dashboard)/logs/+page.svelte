<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import { Filter } from "@gettersethya/mira-collection"
  import { client, type LogsResponse } from "$lib/client.js"
  import { Badge } from "$lib/components/ui/badge/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import * as Select from "$lib/components/ui/select/index.js"
  import { goto } from "$app/navigation"
  import { page } from "$app/state"
  import AppDataTable from "$lib/components/ui/app-data-table/app-data-table.svelte"
  import type { ColumnDef } from "@tanstack/svelte-table"
  import { renderSnippet } from "$lib/components/ui/data-table"

  const LIMIT = 50
  let level = $derived(page.url.searchParams.get("level") ?? "")
  let offset = $derived(Number(page.url.searchParams.get("offset") ?? 0))

  const logsQuery = createQuery(() => ({
    queryKey: ["logs", level, offset],
    queryFn: () => client.logs({ limit: LIMIT, offset })
  }))

  const totalPages = $derived(logsQuery.data ? Math.ceil(logsQuery.data.total / LIMIT) : 0)
  const currentPage = $derived(Math.floor(offset / LIMIT) + 1)

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
      accessorKey: "message"
    },
    {
      accessorKey: "traceId",
      cell: ({ row }) => row.original.spanId ?? "-"
    }
  ]
</script>

<div class="space-y-4 py-4">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold">Logs</h1>
    {@render LogSelectSnippet()}
  </div>

  {#if logsQuery.isLoading}
    <p class="text-muted-foreground">Loading…</p>
  {:else if logsQuery.data}
    <AppDataTable {columns} data={logsQuery.data.logs} />

    <div class="flex items-center justify-between text-sm text-muted-foreground">
      <span>{logsQuery.data.total} total</span>
      <div class="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0}
          onclick={() => {
            const searchParams = page.url.searchParams
            searchParams.set("offset", Math.max(0, offset - LIMIT).toString())
            return goto(`${page.url.pathname}?${searchParams.toString()}`)
          }}
        >
          Prev
        </Button>
        <span class="px-2 py-1">Page {currentPage} of {totalPages}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={offset + LIMIT >= logsQuery.data.total}
          onclick={() => {
            const newOffset = (offset += LIMIT)
            const searchParams = page.url.searchParams
            searchParams.set("offset", newOffset.toString())
            return goto(`${page.url.pathname}?${searchParams.toString()}`)
          }}
        >
          Next
        </Button>
      </div>
    </div>
  {/if}
</div>

{#snippet LogSelectSnippet()}
  <Select.Root
    type="single"
    value={level}
    onValueChange={(v) => {
      const searchParams = page.url.searchParams
      searchParams.set("level", v)
      searchParams.set("offset", "0")
      return goto(`${page.url.pathname}?${searchParams.toString()}`)
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
{/snippet}

{#snippet LevelCellSnippet({ level }: { level: string })}
  <Badge variant={levelVariant(level)} class="text-xs">{level}</Badge>
{/snippet}
