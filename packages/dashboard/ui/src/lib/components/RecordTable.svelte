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
  import type { CollectionSchema } from "$lib/dashboard-api.js"
  import { isGeneratedField, isTableHiddenField, isSystemField, fieldKind, relationLabelField, stripHiddenValues } from "$lib/schema.js"
  import {
    getCoreRowModel,
    type ColumnDef,
    type Row,
    type Table as TanStackTable
  } from "@tanstack/table-core"
  import { createSvelteTable, renderSnippet, FlexRender } from "$lib/components/ui/data-table"
  import { cn } from "$lib/utils"
  import { IconDotsVertical, IconCopy, IconTrash, IconPencil, IconStack2, IconArrowDown, IconArrowUp } from "@tabler/icons-svelte"
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

  type SortOrder = "asc" | "desc"

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
    onSelectionChange,
    sortField = "created",
    sortOrder = "desc",
    onSort,
    emptyTitle = "No records yet",
    emptyDescription = "Create the first record to start using this collection.",
    emptyActionLabel = "New record",
    emptyAction
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
    sortField?: string
    sortOrder?: SortOrder
    onSort?: (field: string) => void
    emptyTitle?: string
    emptyDescription?: string
    emptyActionLabel?: string
    emptyAction?: () => void
  } = $props()

  function displayFieldName(fieldName: string): string {
    if (fieldName === "id") return "ID"
    if (fieldName === "emailVerified") return "Verified"
    if (fieldName === "seqId") return "Sequence"
    const spaced = fieldName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")
    return spaced.charAt(0).toUpperCase() + spaced.slice(1)
  }

  function isTimestampColumn(columnId: string): boolean {
    return columnId === "created" || columnId === "updated"
  }

  function timestampVisibility(_columnId: string): string {
    return "hidden md:table-cell"
  }

  function sortBy(columnId: string) {
    onSort?.(columnId)
  }

  const hasBulk = $derived(bulkActions.length > 0)
  const dataFields = $derived(
    Object.entries(schema.fields)
      .filter(([, field]) => !isGeneratedField(field) && !isTableHiddenField(field))
      .map(([name, field]) => ({ name, kind: fieldKind(field) }))
  )
  const textFields = $derived(dataFields.filter((field) => field.kind === "text" || field.kind === "literalText"))
  const identityField = $derived(
    textFields.find((field) => ["name", "title", "label"].includes(field.name)) ??
      textFields.find((field) => !isSystemField(schema.fields[field.name])) ??
      textFields[0] ??
      { name: "id", kind: "text" }
  )
  const orderedDataFields = $derived.by(() => {
    const fields = [...dataFields]
    const identityIndex = fields.findIndex((field) => field.name === identityField.name)
    if (identityIndex > 0) {
      const [identity] = fields.splice(identityIndex, 1)
      fields.unshift(identity)
    }
    return fields
  })
  const secondaryField = $derived(
    textFields.find((field) => field.name !== identityField.name) ?? null
  )
  const statusField = $derived(dataFields.find((field) => field.kind === "bool") ?? null)

  function statusLabel(fieldName: string, value: unknown): string {
    if (fieldName === "emailVerified") return value ? "Verified" : "Unverified"
    if (fieldName === "published") return value ? "Published" : "Draft"
    return value ? "Yes" : "No"
  }

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

  function findSelectedRecords(): Record<string, unknown>[] {
    return records.filter((r) => selectedIds.has(recordId(r)))
  }

  function isRowSelected(row: Record<string, unknown>): boolean {
    return selectedIds.has(recordId(row))
  }

  /**
   * Selection lives entirely in `selectedIds` (reactive Svelte state), never in
   * TanStack's internal row-selection state. `createSvelteTable` stores
   * `options.state` as a plain snapshot in its merged table state, so
   * `row.getIsSelected()` is not reactive — cells that read it never re-render
   * when the selection changes (the header, which reads the `$derived` above,
   * would update while every row stayed stale). Cells therefore read
   * `selectedIds` directly and toggling writes back to it.
   */
  function applySelection(next: SvelteSet<string>) {
    selectedIds = next
    onSelectionChange?.(new Set(next))
  }

  function toggleRow(id: string) {
    if (bulkRunning) return
    const next = new SvelteSet(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    applySelection(next)
  }

  function toggleAllSelection() {
    if (bulkRunning) return
    applySelection(allSelected ? new SvelteSet() : new SvelteSet(records.map(recordId)))
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

    for (const { name: col, kind } of orderedDataFields) {
      const target = relationSchemas[col] ?? null
      const labelField = kind === "relation" ? relationLabelField(target ?? undefined) : null
      cols.push({
        accessorKey: col,
        header: displayFieldName(col),
        cell: ({ row }) =>
          kind === "relation"
            ? renderSnippet(RelationCell, {
                id: row.original[col],
                related: relationValue(row.original, col),
                labelField
              })
            : renderSnippet(ValueCell, { value: row.original[col], kind, field: col })
      })
    }

    cols.push({
      accessorKey: "id",
      header: "ID",
      cell: ({ row }) => renderSnippet(IdCell, { id: recordId(row.original) }),
      size: 1
    })

    if ("created" in schema.fields) {
      cols.push({
        accessorKey: "created",
        header: "Created",
        cell: ({ row }) => renderSnippet(ValueCell, { value: row.original["created"], kind: "date", field: "created" }),
        size: 1
      })
    }

    if ("updated" in schema.fields) {
      cols.push({
        accessorKey: "updated",
        header: "Updated",
        cell: ({ row }) => renderSnippet(ValueCell, { value: row.original["updated"], kind: "date", field: "updated" }),
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
    getCoreRowModel: getCoreRowModel()
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

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id)
      toast.success("Copied record ID")
    } catch {
      toast.error("Failed to copy ID")
    }
  }

  function copyJson(record: Record<string, unknown>) {
    // Strip `x-hidden` columns (auth password hashes) before copying.
    navigator.clipboard.writeText(JSON.stringify(stripHiddenValues(schema, record), null, 2))
    toast.success("Copied to clipboard")
  }

  function parseDate(value: unknown): Date | null {
    const date = typeof value === "string" || typeof value === "number" ? new Date(value) : new Date(Number.NaN)
    return Number.isNaN(date.getTime()) ? null : date
  }

  function formatDate(value: unknown, timeZone?: string): string {
    const date = parseDate(value)
    if (!date) return String(value)
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone
    }).format(date)
  }

  function formatTime(value: unknown, timeZone?: string): string {
    const date = parseDate(value)
    if (!date) return String(value)
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone
    }).format(date)
  }

  function formatDateTime(value: unknown, timeZone?: string): string {
    const date = parseDate(value)
    if (!date) return String(value)
    return `${formatDate(value, timeZone)} ${formatTime(value, timeZone)}`
  }
</script>

<div class="hidden max-h-[calc(100vh-17rem)] min-w-0 overflow-auto rounded-md border md:block">
  <Table.Root>
    <Table.Caption class="sr-only">Records in {schema.name}</Table.Caption>
    <Table.Header class="bg-background sticky top-0 z-10">
      {#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
        <Table.Row>
          {#each headerGroup.headers as header (header.id)}
            {@const isCompact = header.getSize() === 20}
            {@const isSortable = onSort !== undefined && header.column.id !== "select" && header.column.id !== "actions"}
            <Table.Head
              scope="col"
              colspan={header.colSpan}
              aria-sort={sortField === header.column.id ? (sortOrder === "asc" ? "ascending" : "descending") : undefined}
              class={cn(
                "text-muted-foreground text-[0.6875rem] font-medium tracking-[0.02em]",
                sortField === header.column.id && "text-foreground",
                isTimestampColumn(header.column.id) && timestampVisibility(header.column.id),
                isCompact && "w-1"
              )}
            >
              {#if !header.isPlaceholder}
                {#if isSortable}
                  <button
                    type="button"
                    class="hover:text-foreground inline-flex items-center gap-1 rounded-sm text-left"
                    aria-label={`Sort by ${header.column.id}`}
                    onclick={() => sortBy(header.column.id)}
                  >
                    <FlexRender content={header.column.columnDef.header} context={header.getContext()} />
                    {#if sortField === header.column.id}
                      {#if sortOrder === "asc"}
                        <IconArrowUp class="size-3" />
                      {:else}
                        <IconArrowDown class="size-3" />
                      {/if}
                    {/if}
                  </button>
                {:else}
                  <FlexRender content={header.column.columnDef.header} context={header.getContext()} />
                {/if}
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
          data-state={isRowSelected(row.original) ? "selected" : undefined}
          onclick={() => onEdit(recordId(row.original))}
        >
          {#each row.getVisibleCells() as cell (cell.id)}
            {#if cell.column.id === "actions" || cell.column.id === "select"}
              <Table.Cell onclick={(e) => e.stopPropagation()}>
                <FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
              </Table.Cell>
            {:else}
              <Table.Cell class={cn(isTimestampColumn(cell.column.id) && timestampVisibility(cell.column.id))}>
                <FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
              </Table.Cell>
            {/if}
          {/each}
        </Table.Row>
      {:else}
        <Table.Row>
          <Table.Cell colspan={columns.length} class="h-44 text-center">
            <div class="mx-auto flex max-w-sm flex-col items-center gap-3 py-6">
              <span class="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-full">
                <IconStack2 class="size-4" />
              </span>
              <div class="space-y-1">
                <p class="text-sm font-medium">{emptyTitle}</p>
                <p class="text-muted-foreground text-xs leading-relaxed">{emptyDescription}</p>
              </div>
              {#if emptyAction && emptyActionLabel}
                <Button variant="outline" class="!h-11 sm:!h-9" onclick={emptyAction}>{emptyActionLabel}</Button>
              {/if}
            </div>
          </Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
</div>

<div class="divide-y rounded-md border md:hidden">
  {#if records.length === 0}
    <div class="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span class="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-full">
        <IconStack2 class="size-4" />
      </span>
      <div class="space-y-1">
        <p class="text-sm font-medium">{emptyTitle}</p>
        <p class="text-muted-foreground text-xs leading-relaxed">{emptyDescription}</p>
      </div>
      {#if emptyAction && emptyActionLabel}
        <Button variant="outline" class="!h-11 sm:!h-9" onclick={emptyAction}>{emptyActionLabel}</Button>
      {/if}
    </div>
  {:else}
    {#each records as record (recordId(record))}
      {@const recordKey = recordId(record)}
      <article
        class={cn("flex items-start gap-3 p-4", isRowSelected(record) && "bg-muted/50")}
        data-state={isRowSelected(record) ? "selected" : undefined}
      >
        <Checkbox
          class="mt-0.5"
          checked={isRowSelected(record)}
          onCheckedChange={() => toggleRow(recordKey)}
          disabled={bulkRunning}
          aria-label={`Select ${String(record[identityField.name] ?? recordKey)}`}
        />
        <button
          type="button"
          class="min-w-0 flex-1 text-left"
          onclick={() => onEdit(recordKey)}
          aria-label={`${String(record[identityField.name] ?? recordKey)} - open record ${recordKey}`}
        >
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate text-sm font-medium">{String(record[identityField.name] ?? recordKey)}</span>
            {#if statusField}
              <span
                class={cn(
                  "shrink-0 rounded-full border px-1.5 py-0.5 text-[0.6875rem]",
                  record[statusField.name]
                    ? "border-primary/30 text-primary bg-primary/5"
                    : "border-border text-muted-foreground"
                )}
              >
                {statusLabel(statusField.name, record[statusField.name])}
              </span>
            {/if}
          </div>
          {#if secondaryField && record[secondaryField.name] !== null && record[secondaryField.name] !== undefined}
            <p class="text-muted-foreground mt-1 truncate text-xs">{String(record[secondaryField.name])}</p>
          {/if}
          <div class="text-muted-foreground tabular mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.6875rem]">
            <span class="font-mono">ID {recordKey.slice(0, 8)}</span>
            {#if "created" in schema.fields}
              <span>Created {formatDate(record["created"])}</span>
            {/if}
            {#if "updated" in schema.fields}
              <span>Updated {formatDate(record["updated"])}</span>
            {/if}
          </div>
        </button>
        {@render ActionsCell({ id: recordKey, record })}
      </article>
    {/each}
  {/if}
</div>

{#if hasMore && onLoadMore}
  <div class="mt-4 flex justify-center">
    <Button variant="outline" class="!h-11 sm:!h-9" onclick={onLoadMore}>Load more</Button>
  </div>
{/if}

{#if hasBulk && selectedCount > 0}
  <div use:portal class="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-3">
    <div
      in:fly={{ y: 16, duration: 150 }}
      class="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-full border bg-background px-2 py-2 shadow-lg sm:gap-2 sm:px-3"
    >
      <span class="whitespace-nowrap px-1 text-sm font-medium sm:px-2" aria-live="polite">
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
          class="!h-11 shrink-0 whitespace-nowrap sm:!h-8"
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
      <AlertDialog.Cancel class="!h-11 sm:!h-9">Cancel</AlertDialog.Cancel>
      <AlertDialog.Action
        class="bg-destructive text-destructive-foreground hover:bg-destructive/90 !h-11 sm:!h-9"
        onclick={confirmDelete}
        disabled={deleting}
      >
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
      <AlertDialog.Cancel class="!h-11 sm:!h-9">Cancel</AlertDialog.Cancel>
      <AlertDialog.Action class="!h-11 sm:!h-9" onclick={confirmRun}>Confirm</AlertDialog.Action>
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
    checked={isRowSelected(row.original)}
    onCheckedChange={() => toggleRow(recordId(row.original))}
    disabled={bulkRunning}
    aria-label={`Select ${String(row.original[identityField.name] ?? recordId(row.original))}`}
  />
{/snippet}

{#snippet IdCell({ id }: { id: string })}
  <div class="inline-flex max-w-[150px] items-center gap-1">
    <button
      type="button"
      class="hover:text-primary max-w-[100px] truncate font-mono text-xs text-left underline-offset-2 hover:underline"
      title={id}
      aria-label={`Open record ${id}`}
      onclick={(event) => {
        event.stopPropagation()
        onEdit(id)
      }}
    >
      {id.slice(0, 8)}
    </button>
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground inline-flex size-9 shrink-0 items-center justify-center rounded-sm"
      aria-label={`Copy record ID ${id}`}
      title="Copy ID"
      onclick={(event) => {
        event.stopPropagation()
        void copyId(id)
      }}
    >
      <IconCopy class="size-3" />
    </button>
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

{#snippet ValueCell({ value, kind, field }: { value: unknown; kind: string; field: string })}
  {#if value === null || value === undefined}
    <div class="max-w-[200px] truncate text-sm">
      <span class="text-muted-foreground">—</span>
    </div>
  {:else if kind === "bool"}
    <span class="inline-flex items-center gap-1.5 text-xs">
      <span
        class={value ? "bg-primary size-1.5 rounded-full" : "bg-muted-foreground/40 size-1.5 rounded-full"}
        aria-hidden="true"
      ></span>
      <span class={value ? "text-foreground" : "text-muted-foreground"}>{statusLabel(field, value)}</span>
    </span>
  {:else if kind === "json"}
    <div class="max-w-[200px] truncate font-mono text-xs">
      {typeof value === "string" ? value : JSON.stringify(value)}
    </div>
  {:else if kind === "date"}
    <div
      class="tabular flex max-w-[200px] flex-col truncate text-left text-xs"
      title={`${formatDateTime(value, "UTC")} UTC`}
    >
      <span>
        {formatDate(value)}
      </span>
      <span class="text-muted-foreground text-[0.6875rem]">
        {formatTime(value)}
      </span>
    </div>
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
        <Button
          {...props}
          variant="ghost"
          size="icon"
          class="size-11 lg:size-9"
          aria-label={`Record actions for ${id}`}
        >
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
