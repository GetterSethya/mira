<script lang="ts">
  import { createMutation, createQuery } from "@tanstack/svelte-query"
  import { dashboardApi, run } from "$lib/dashboard-api.js"
  import type { CronApiState } from "$lib/dashboard-api.js"
  import { Badge } from "$lib/components/ui/badge/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import AppDataTable from "$lib/components/ui/app-data-table/app-data-table.svelte"
  import TableSkeleton from "$lib/components/TableSkeleton.svelte"
  import type { ColumnDef } from "@tanstack/svelte-table"
  import { renderSnippet } from "$lib/components/ui/data-table"
  import { toast } from "svelte-sonner"
  import { IconCheck, IconReload, IconX, IconZzz } from "@tabler/icons-svelte"
  import Spinner from "$lib/components/ui/spinner/spinner.svelte"

  const cronsQuery = createQuery<CronApiState[]>(() => ({
    queryKey: ["crons"],
    queryFn: () => run(dashboardApi.crons.getAll()),
    refetchInterval: 5000
  }))

  const runNowMutation = createMutation(() => ({
    mutationFn: (name: string) => run(dashboardApi.crons.runNow(name)),
    onSuccess: (_, name) => {
      toast.success(`Started "${name}"`)
      cronsQuery.refetch()
    },
    onError: (_, name) => {
      toast.error(`Failed to run "${name}"`)
    }
  }))

  function formatDuration(ms: number | null): string {
    if (ms === null) return "-"
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  const columns: ColumnDef<CronApiState>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => row.original.name
    },
    {
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => row.original.description ?? "-"
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => renderSnippet(StatusBadge, { status: row.original.status })
    },
    {
      accessorKey: "lastRunAt",
      header: "Last Run",
      cell: ({ row }) => (row.original.lastRunAt ? new Date(row.original.lastRunAt).toLocaleString() : "-")
    },
    {
      accessorKey: "lastDurationMs",
      header: "Duration",
      cell: ({ row }) => formatDuration(row.original.lastDurationMs)
    },
    {
      accessorKey: "lastStatus",
      header: "Last Result",
      cell: ({ row }) => renderSnippet(ResultBadge, { status: row.original.lastStatus })
    },
    {
      accessorKey: "lastError",
      header: "Last Error",
      cell: ({ row }) => renderSnippet(ErrorCell, { error: row.original.lastError })
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => renderSnippet(RunNowCell, { cron: row.original })
    }
  ]
</script>

<div class="space-y-4 py-4">
  <div class="flex gap-2 items-center justify-between">
    <h1 class="text-2xl font-bold">Cron Jobs</h1>
    <Button class="ms-auto" variant="outline" onclick={cronsQuery.refetch} disabled={cronsQuery.isRefetching}>
      <IconReload class={cronsQuery.isRefetching && "animate-spin"} />
    </Button>
  </div>
  {#if cronsQuery.isLoading}
    <TableSkeleton columns={columns.length} rows={8} />
  {:else if cronsQuery.data}
    <AppDataTable {columns} data={cronsQuery.data} />
  {/if}
</div>

{#snippet StatusBadge({ status }: { status: CronApiState["status"] })}
  {#if status === "running"}
    <Badge variant="default">
      <Spinner />
      Running
    </Badge>
  {:else}
    <Badge variant="outline">
      <IconZzz />
      Standby
    </Badge>
  {/if}
{/snippet}

{#snippet ResultBadge({ status }: { status: CronApiState["lastStatus"] })}
  {#if status === "success"}
    <Badge variant="default">
      <IconCheck />
      Success
    </Badge>
  {:else if status === "error"}
    <Badge variant="destructive">
      <IconX />
      Error
    </Badge>
  {:else}
    -
  {/if}
{/snippet}

{#snippet ErrorCell({ error }: { error: string | null })}
  {#if error}
    <span title={error} class="text-destructive text-xs">
      {error.length > 60 ? error.slice(0, 60) + "…" : error}
    </span>
  {:else}
    -
  {/if}
{/snippet}

{#snippet RunNowCell({ cron }: { cron: CronApiState })}
  <Button
    variant="outline"
    size="sm"
    disabled={cron.status === "running" || (runNowMutation.isPending && runNowMutation.variables === cron.name)}
    onclick={() => runNowMutation.mutate(cron.name)}
  >
    Run Now
  </Button>
{/snippet}
