<script module lang="ts">
  import type { Icon } from "@tabler/icons-svelte"
  import type { ButtonVariant } from "$lib/components/ui/button/index.js"

  export type BulkActionContext = {
    selectedRecords: Record<string, unknown>[]
    onProgress: (done: number, total: number) => void
  }

  export type BulkAction = {
    id: string
    label: string
    icon?: Icon
    variant?: ButtonVariant
    disabled?: boolean
    confirm?: (ctx: BulkActionContext) => { title: string; description: string }
    progressLabel?: (done: number, total: number) => string
    run: (ctx: BulkActionContext) => Promise<void> | void
  }
</script>

<script lang="ts">
  import * as Table from "$lib/components/ui/table/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import { Checkbox } from "$lib/components/ui/checkbox/index.js"
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js"
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js"
  import * as Tooltip from "$lib/components/ui/tooltip/index.js"
  import type { CollectionSchema } from "$lib/dashboard-api.js"
  import { isGeneratedField, isTableHiddenField, isSystemField, fieldKind, relationLabelField } from "$lib/schema.js"
  import {
    getCoreRowModel,
    type ColumnDef,
    type Row,
    type RowSelectionState,
    type Table as TanStackTable,
    type Updater
  } from "@tanstack/table-core"
  import { createSvelteTable, renderSnippet, FlexRender } from "$lib/components/ui/data-table"
  import { cn } from "$lib/utils"
  import { Switch } from "$lib/components/ui/switch/index.js"
  import { IconDotsVertical, IconCopy, IconTrash, IconPencil } from "@tabler/icons-svelte"
  import { IconSize } from "$lib/constants"
  import { SvelteSet } from "svelte/reactivity"
  import { fly } from "svelte/transition"
  import { toast } from "svelte-sonner"

  /** Every collection row has a string `id`. Rows are untyped `Record<string, unknown>`. */
  function recordId(record: Record<string, unknown>): string {
    const id = record["id"]
    return typeof id === "string" ? id : String(id)
  }

  /** Narrows an unknown expand payload to a string-keyed record. */
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  /** Reads the expanded related record for `field` from `record.expand`, if present. */
  function relationValue(
    record: Record<string, unknown>,
    field: string
  ): Record<string, unknown> | null {
    const expand: unknown = record["expand"]
    if (!isRecord(expand)) return null
    const related: unknown = expand[field]
    if (!isRecord(related)) return null
    return related
  }

  let {
    schema,
    records,
    relationSchemas = {},
    onEdit,
    onDelete,
    onLoadMore,
    hasMore = false,
    bulkActions = [],
    selectedIds = $bindable(new SvelteSet<string>()),
    onSelectionChange
  }: {
    schema: CollectionSchema
    records: Record<string, unknown>[]
    relationSchemas?: Record<string, CollectionSchema | null>
    onEdit: (id: string) => void
    onDelete: (id: string) => Promise<void>
    onLoadMore?: () => void
    hasMore?: boolean
    bulkActions?: BulkAction[]
    selectedIds?: ReadonlySet<string>
    onSelectionChange?: (ids: Set<string>) => void
  } = $props()

  const hasBulk = $derived(bulkActions.length > 0)

  let runningActionId = $state<string | null>(null)
  let progress = $state<{ done: number; total: number } | null>(null)
  let confirmAction = $state<BulkAction | null>(null)
  let deleteId = $state<string | null>(null)
  let deleting = $state(false)

  const bulkRunning = $derived(runningActionId !== null)
  const selectedCount = $derived(selectedIds.size)
  const allSelected = $derived(
    hasBulk && records.length > 0 && records.every((r) => selectedIds.has(recordId(r)))
  )
  const someSelected = $derived(selectedCount > 0 && !allSelected)

  const rowSelection = $derived.by((): RowSelectionState => {
    const state: RowSelectionState = {}
    for (const id of selectedIds) state[id] = true
    return state
  })

  function findSelectedRecords(): Record<string, unknown>[] {
    return records.filter((r) => selectedIds.has(recordId(r)))
  }

  function handleRowSelectionChange(updater: Updater<RowSelectionState>) {
    if (bulkRunning) return
    const next = typeof updater === "function" ? updater(rowSelection) : updater
    const ids = new SvelteSet<string>()
    for (const [id, selected] of Object.entries(next)) {
      if (selected) ids.add(id)
    }
    selectedIds = ids
    onSelectionChange?.(new Set(ids))
  }

  function toggleAllSelection() {
    if (bulkRunning) return
    table.toggleAllRowsSelected(!allSelected)
  }

  function makeCtx(): BulkActionContext {
    return {
      selectedRecords: findSelectedRecords(),
      onProgress: (done, total) => {
        progress = { done, total }
      }
    }
  }

  function requestRun(action: BulkAction) {
    if (bulkRunning || action.disabled) return
    if (action.confirm) {
      confirmAction = action
      return
    }
    void executeAction(action)
  }

  async function executeAction(action: BulkAction) {
    runningActionId = action.id
    progress = null
    try {
      await action.run(makeCtx())
    } catch {
      toast.error("Action failed")
    } finally {
      runningActionId = null
      progress = null
      selectedIds = new SvelteSet()
      onSelectionChange?.(new Set())
    }
  }

  function confirmRun() {
    const action = confirmAction
    confirmAction = null
    if (action) void executeAction(action)
  }

  const confirmText = $derived.by(() => {
    if (!confirmAction || !confirmAction.confirm) return null
    return confirmAction.confirm({ selectedRecords: findSelectedRecords(), onProgress: () => {} })
  })

  const columns = $derived.by((): ColumnDef<Record<string, unknown>>[] => {
    const cols: ColumnDef<Record<string, unknown>>[] = []

    if (hasBulk) {
      cols.push({
        id: "select",
        header: ({ table }) => renderSnippet(SelectAllHeader, { table }),
        cell: ({ row }) => renderSnippet(SelectCell, { row }),
        size: 1,
        enableSorting: false
      })
    }

    cols.push({
      accessorKey: "id",
      header: "id",
      cell: ({ row }) => renderSnippet(IdCell, { id: recordId(row.original) }),
      size: 1
    })

    for (const [col, field] of Object.entries(schema.fields)) {
      if (isGeneratedField(field) || isTableHiddenField(field)) continue
      const kind = fieldKind(field)
      const target = relationSchemas[col] ?? null
      const labelField = kind === "relation" ? relationLabelField(target ?? undefined) : null
      cols.push({
        accessorKey: col,
        header: col,
        cell: ({ row }) =>
          kind === "relation"
            ? renderSnippet(RelationCell, {
                id: row.original[col],
                related: relationValue(row.original, col),
                labelField
              })
            : renderSnippet(ValueCell, { value: row.original[col], kind })
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
      cell: ({ row }) => renderSnippet(ActionsCell, { id: recordId(row.original), record: row.original }),
      size: 1
    })

    return cols
  })

  const table = createSvelteTable({
    get data() {
      return records
    },
    get columns() {
      return columns
    },
    getRowId: (row) => recordId(row),
    enableRowSelection: true,
    getCoreRowModel: getCoreRowModel(),
    get state() {
      return { rowSelection }
    },
    onRowSelectionChange: (updater) => handleRowSelectionChange(updater)
  })

  /** Moves the element to <body> so no ancestor can become its containing block. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node)
    return {
      destroy() {
        node.remove()
      }
    }
  }

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
              class={cn(isSystemField(schema.fields[header.column.id]) && "text-muted-foreground", isCompact && "w-1")}
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
          data-state={row.getIsSelected() ? "selected" : undefined}
          onclick={() => onEdit(recordId(row.original))}
        >
          {#each row.getVisibleCells() as cell (cell.id)}
            {#if cell.column.id === "actions" || cell.column.id === "select"}
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

{#if hasBulk && selectedCount > 0}
  <div use:portal class="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-3">
    <div
      in:fly={{ y: 16, duration: 150 }}
      class="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-full border bg-background px-2 py-2 shadow-lg sm:gap-2 sm:px-3"
    >
      <span class="whitespace-nowrap px-1 text-sm font-medium sm:px-2">
        Selected {selectedCount}<span class="hidden sm:inline"> records</span>
      </span>
      {#if bulkRunning}
        {@const active = bulkActions.find((a) => a.id === runningActionId)}
        <span class="whitespace-nowrap px-1 text-sm text-muted-foreground sm:px-2">
          {progress && active?.progressLabel
            ? active.progressLabel(progress.done, progress.total)
            : `${active?.label ?? "Working"}…`}
        </span>
        {#if progress && progress.total > 0}
          <div class="hidden h-1 w-24 overflow-hidden rounded-full bg-muted sm:block">
            <div
              class="h-full bg-primary transition-all"
              style={`width: ${Math.round((progress.done / progress.total) * 100)}%`}
            ></div>
          </div>
        {/if}
      {/if}
      {#each bulkActions as action (action.id)}
        {@const ActionIcon = action.icon}
        <Button
          variant={action.variant ?? "ghost"}
          size="sm"
          class="shrink-0 whitespace-nowrap"
          disabled={bulkRunning || action.disabled}
          onclick={() => requestRun(action)}
        >
          {#if ActionIcon}
            <ActionIcon size={IconSize} class="-translate-y-[1.5px]" />
          {/if}
          {action.label}
        </Button>
      {/each}
    </div>
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

<AlertDialog.Root
  open={confirmAction !== null}
  onOpenChange={(o) => {
    if (!o) confirmAction = null
  }}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{confirmText?.title ?? ""}</AlertDialog.Title>
      <AlertDialog.Description>{confirmText?.description ?? ""}</AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmRun}>Confirm</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

{#snippet SelectAllHeader({ table }: { table: TanStackTable<Record<string, unknown>> })}
  <Checkbox
    checked={allSelected}
    indeterminate={someSelected}
    onCheckedChange={() => toggleAllSelection()}
    disabled={bulkRunning}
    aria-label="Select all rows"
  />
{/snippet}

{#snippet SelectCell({ row }: { row: Row<Record<string, unknown>> })}
  <Checkbox
    checked={row.getIsSelected()}
    onCheckedChange={() => row.toggleSelected()}
    disabled={bulkRunning}
    aria-label="Select row"
  />
{/snippet}

{#snippet IdCell({ id }: { id: string })}
  <div class="max-w-[200px] truncate text-sm">
    {id.slice(0, 80)}
  </div>
{/snippet}

{#snippet RelationCell({ id, related, labelField }: { id: unknown; related: Record<string, unknown> | null; labelField: string | null })}
  {#if related && labelField && related[labelField] !== null && related[labelField] !== undefined}
    <div class="max-w-[200px] truncate text-sm" title={String(id ?? "")}>
      {String(related[labelField]).slice(0, 80)}
    </div>
  {:else if id === null || id === undefined}
    <div class="max-w-[200px] truncate text-sm">
      <span class="text-muted-foreground">—</span>
    </div>
  {:else}
    <div class="max-w-[200px] truncate text-sm">
      {String(id).slice(0, 80)}
    </div>
  {/if}
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

{#snippet ActionsCell({ id, record }: { id: string; record: Record<string, unknown> })}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="icon" class="size-8">
          <IconDotsVertical size={IconSize} />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end">
      <DropdownMenu.Item class="cursor-pointer" onclick={() => onEdit(id)}>
        <IconPencil />
        Edit
      </DropdownMenu.Item>
      <DropdownMenu.Item class="cursor-pointer" onclick={() => copyJson(record)}>
        <IconCopy />
        Copy JSON
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
      <DropdownMenu.Item class="cursor-pointer text-destructive" onclick={() => (deleteId = id)}>
        <IconTrash class="text-destructive" />
        Delete
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}
