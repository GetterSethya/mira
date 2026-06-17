<script lang="ts">
  import * as Table from "$lib/components/ui/table/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js"
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js"
  import * as Tooltip from "$lib/components/ui/tooltip/index.js"
  import type { CollectionSchema } from "$lib/dashboard-api.js"
  import { isSystemField, fieldKind } from "$lib/schema.js"
  import { resolve } from "$app/paths"
  import { goto } from "$app/navigation"
  import { getCoreRowModel, type ColumnDef } from "@tanstack/table-core"
  import { createSvelteTable, renderSnippet, FlexRender } from "$lib/components/ui/data-table"
  import { cn } from "$lib/utils"
  import { Switch } from "$lib/components/ui/switch/index.js"
  import { IconDotsVertical, IconCopy, IconTrash } from "@tabler/icons-svelte"
  import { IconSize } from "$lib/constants"
  import { toast } from "svelte-sonner"

  const {
    schema,
    records,
    collectionName,
    onDelete,
    onLoadMore,
    hasMore = false
  }: {
    schema: CollectionSchema
    records: Record<string, unknown>[]
    collectionName: string
    onDelete: (id: string) => Promise<void>
    onLoadMore?: () => void
    hasMore?: boolean
  } = $props()

  const columns = $derived.by((): ColumnDef<Record<string, unknown>>[] => {
    const cols: ColumnDef<Record<string, unknown>>[] = [
      {
        accessorKey: "id",
        header: "id",
        cell: ({ row }) => renderSnippet(IdCell, { id: row.original["id"] }),
        size: 1
      }
    ]

    for (const col of Object.keys(schema.fields).filter((c) => !isSystemField(c))) {
      const kind = fieldKind(schema.fields[col]!)
      cols.push({
        accessorKey: col,
        header: col,
        cell: ({ row }) => renderSnippet(ValueCell, { value: row.original[col], kind })
      })
    }

    if ("created" in schema.fields) {
      cols.push({
        accessorKey: "created",
        header: "created",
        cell: ({ row }) => renderSnippet(ValueCell, { value: row.original["created"], kind: "date" }),
        size: 1
      })
    }

    if ("updated" in schema.fields) {
      cols.push({
        accessorKey: "updated",
        header: "updated",
        cell: ({ row }) => renderSnippet(ValueCell, { value: row.original["updated"], kind: "date" }),
        size: 1
      })
    }

    cols.push({
      id: "actions",
      header: "Actions",
      cell: ({ row }) => renderSnippet(ActionsCell, { id: row.original["id"], record: row.original }),
      size: 1
    })

    return cols
  })

  const getColumns = () => columns
  const table = createSvelteTable({
    get data() {
      return records
    },
    columns: getColumns(),
    getCoreRowModel: getCoreRowModel()
  })

  let deleteId = $state<string | null>(null)
  let deleting = $state(false)

  async function confirmDelete() {
    if (!deleteId) return
    deleting = true
    await onDelete(deleteId)
    deleting = false
    deleteId = null
  }

  function copyJson(record: Record<string, unknown>) {
    navigator.clipboard.writeText(JSON.stringify(record, null, 2))
    toast.success("Copied to clipboard")
  }

  function parseDate(value: unknown): Date | null {
    const date = new Date(value as string | number)
    return Number.isNaN(date.getTime()) ? null : date
  }

  function formatDate(value: unknown, timeZone?: string): string {
    const date = parseDate(value)
    if (!date) return String(value)
    return date.toLocaleDateString(undefined, { timeZone })
  }

  function formatTime(value: unknown, timeZone?: string): string {
    const date = parseDate(value)
    if (!date) return String(value)
    return date.toLocaleTimeString(undefined, { hour12: false, timeZone })
  }

  function formatDateTime(value: unknown, timeZone?: string): string {
    const date = parseDate(value)
    if (!date) return String(value)
    return `${formatDate(value, timeZone)} ${formatTime(value, timeZone)}`
  }
</script>

<div class="rounded-md border overflow-x-auto">
  <Table.Root>
    <Table.Header>
      {#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
        <Table.Row>
          {#each headerGroup.headers as header (header.id)}
            {@const isCompact = header.getSize() === 20}
            <Table.Head
              colspan={header.colSpan}
              class={cn(isSystemField(header.column.id) && "text-muted-foreground", isCompact && "w-1")}
            >
              {#if !header.isPlaceholder}
                <FlexRender content={header.column.columnDef.header} context={header.getContext()} />
              {/if}
            </Table.Head>
          {/each}
        </Table.Row>
      {/each}
    </Table.Header>
    <Table.Body>
      {#each table.getRowModel().rows as row (row.id)}
        <Table.Row
          class="cursor-pointer hover:bg-muted/50"
          onclick={() => {
            const id = row.original["id"]
            if (typeof id === "string") goto(resolve(`/collections/${collectionName}/${id}`))
          }}
        >
          {#each row.getVisibleCells() as cell (cell.id)}
            {#if cell.column.id === "actions"}
              <Table.Cell onclick={(e) => e.stopPropagation()}>
                <FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
              </Table.Cell>
            {:else}
              <Table.Cell>
                <FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
              </Table.Cell>
            {/if}
          {/each}
        </Table.Row>
      {:else}
        <Table.Row>
          <Table.Cell colspan={columns.length} class="h-24 text-center">No results.</Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
</div>

{#if hasMore && onLoadMore}
  <div class="mt-4 flex justify-center">
    <Button variant="outline" onclick={onLoadMore}>Load more</Button>
  </div>
{/if}

<AlertDialog.Root
  open={deleteId !== null}
  onOpenChange={(o) => {
    if (!o) deleteId = null
  }}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete record?</AlertDialog.Title>
      <AlertDialog.Description>
        This will permanently delete record <code>{deleteId}</code>. This action cannot be undone.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmDelete} disabled={deleting}>
        {deleting ? "Deleting…" : "Delete"}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

{#snippet IdCell({ id }: { id: unknown })}
  <div class="max-w-[200px] truncate text-sm">
    {String(id).slice(0, 80)}
  </div>
{/snippet}

{#snippet ValueCell({ value, kind }: { value: unknown; kind: string })}
  {#if value === null || value === undefined}
    <div class="max-w-[200px] truncate text-sm">
      <span class="text-muted-foreground">—</span>
    </div>
  {:else if kind === "bool"}
    <Switch checked={Boolean(value)} disabled />
  {:else if kind === "json"}
    <div class="max-w-[200px] truncate font-mono text-xs">
      {typeof value === "string" ? value : JSON.stringify(value)}
    </div>
  {:else if kind === "date"}
    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger class="flex flex-col max-w-[200px] truncate text-sm block text-left">
          <span>
            {formatDate(value)}
          </span>
          <span class="text-foreground/70 text-xs">
            {formatTime(value)}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Content>
          <p>{formatDateTime(value, "UTC")} UTC</p>
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  {:else}
    <div class="max-w-[200px] truncate text-sm">
      {String(value).slice(0, 80)}
    </div>
  {/if}
{/snippet}

{#snippet ActionsCell({ id, record }: { id: unknown; record: any })}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="icon" class="size-8">
          <IconDotsVertical size={IconSize} />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end">
      <DropdownMenu.Item class="cursor-pointer" onclick={() => copyJson(record)}>
        <IconCopy />
        Copy JSON
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
      <DropdownMenu.Item
        class="cursor-pointer text-destructive"
        onclick={() => {
          deleteId = String(id)
        }}
      >
        <IconTrash class="text-destructive" />
        Delete
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}
