<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query"
  import { page } from "$app/state"
  import { goto } from "$app/navigation"
  import { resolve } from "$app/paths"
  import { Filter } from "@gettersethya/mira-collection"
  import type { FilterNode } from "@gettersethya/mira-client"
  import { mira } from "$lib/mira.js"
  import { makeCollectionApi } from "$lib/collection-client.js"
  import {
    fieldKind,
    isGeneratedField,
    isHiddenField,
    isSeqIdField,
    stripHiddenValues
  } from "$lib/schema.js"
  import RecordTable, { type BulkAction, type BulkActionContext } from "$lib/components/RecordTable.svelte"
  import RecordForm from "$lib/components/RecordForm.svelte"
  import TableSkeleton from "$lib/components/TableSkeleton.svelte"
  import ConnectSheet from "$lib/components/ConnectSheet.svelte"
  import CollectionFilterBuilder, {
    type FilterCondition,
    type FilterConnector
  } from "$lib/components/CollectionFilterBuilder.svelte"
  import FieldIcon from "$lib/components/FieldIcon.svelte"
  import { Button } from "$lib/components/ui/button/index.js"
  import { Badge } from "$lib/components/ui/badge/index.js"
  import { Input } from "$lib/components/ui/input/index.js"
  import * as Select from "$lib/components/ui/select/index.js"
  import * as Sheet from "$lib/components/ui/sheet/index.js"
  import * as Dialog from "$lib/components/ui/dialog/index.js"
  import { toast } from "svelte-sonner"
  import { Spinner } from "$lib/components/ui/spinner"
  import { Skeleton } from "$lib/components/ui/skeleton/index.js"
  import { recordFormStore } from "$lib/stores/record-form-store.svelte"
  import { SvelteSet } from "svelte/reactivity"
  import {
    IconAlertTriangle,
    IconArrowDown,
    IconArrowUp,
    IconDownload,
    IconInfoCircle,
    IconPlugConnected,
    IconPlus,
    IconRefresh,
    IconSearch,
    IconTrash,
    IconX
  } from "@tabler/icons-svelte"

  type ConnectTab = "sdk" | "fetch" | "types"
  type SortOrder = "asc" | "desc"

  function isConnectTab(value: string | null): value is ConnectTab {
    return value === "sdk" || value === "fetch" || value === "types"
  }

  function fieldLabel(fieldName: string): string {
    if (fieldName === "id") return "ID"
    if (fieldName === "seqId") return "Sequence"
    const spaced = fieldName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")
    return spaced.charAt(0).toUpperCase() + spaced.slice(1)
  }

  const schemaQuery = createQuery(() => ({ queryKey: ["schema"], queryFn: () => mira.telemetry.getSchema().raw() }))

  const name = $derived(page.params["name"] ?? "")
  const showSheet = $derived(page.url.searchParams.get("open") !== null)
  const id = $derived(page.url.searchParams.get("id"))
  const connectParam = $derived(page.url.searchParams.get("connect"))
  const connectTab = $derived(isConnectTab(connectParam) ? connectParam : "sdk")
  const schema = $derived(schemaQuery.data?.find((s) => s.name === name) ?? null)
  const collectionTitle = $derived(
    name.replace(/^_/, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
  )
  const api = $derived(makeCollectionApi(name))
  const columnCount = $derived(schema ? Object.keys(schema.fields).length + 1 : 5)

  const relationFields = $derived(
    schema
      ? Object.entries(schema.fields)
          .filter(([, field]) => field["x-kind"] === "relation" && field["x-collection"])
          .map(([fieldName]) => fieldName)
      : []
  )
  const relationSchemas = $derived(
    Object.fromEntries(
      Object.entries(schema?.fields ?? {})
        .filter(([, field]) => field["x-kind"] === "relation" && field["x-collection"])
        .map(([fieldName, field]) => [
          fieldName,
          schemaQuery.data?.find((s) => s.name === field["x-collection"]) ?? null
        ])
    )
  )

  let searchInput = $state("")
  let search = $state("")
  let sortField = $state("")
  let sortOrder = $state<SortOrder>("asc")
  let filterConditions = $state<FilterCondition[]>([])
  let filterConnectors = $state<FilterConnector[]>([])
  let schemaDialogOpen = $state(false)
  let cursor = $state(0)
  let lastData: unknown = null
  let previousName = $state("")

  const searchableFields = $derived(
    schema
      ? Object.entries(schema.fields)
          .filter(([, field]) => {
            if (isGeneratedField(field) || isHiddenField(field) || isSeqIdField(field)) return false
            return fieldKind(field) === "text" || fieldKind(field) === "literalText"
          })
          .map(([fieldName]) => fieldName)
      : []
  )

  const searchFilter = $derived.by((): FilterNode | undefined => {
    const term = search.trim()
    if (term.length === 0 || searchableFields.length === 0) return undefined
    const nodes: FilterNode[] = searchableFields.map((fieldName) => ({
      op: "like",
      field: fieldName,
      value: `%${term}%`
    }))
    return nodes.length === 1 ? nodes[0] : nodes.reduce((left, right) => ({ op: "or", left, right }))
  })

  const sortableFields = $derived(
    schema
      ? [
          ...(Object.hasOwn(schema.fields, "created") ? ["created"] : []),
          ...(Object.hasOwn(schema.fields, "updated") ? ["updated"] : []),
          ...Object.entries(schema.fields)
            .filter(([, field]) => !isHiddenField(field) && !isSeqIdField(field))
            .map(([fieldName]) => fieldName)
            .filter((fieldName) => fieldName !== "created" && fieldName !== "updated")
        ]
      : []
  )

  function filterValue(condition: FilterCondition): string | number | null {
    const field = schema?.fields[condition.field]
    if (!field) return null
    const kind = fieldKind(field)
    if (kind === "number") {
      const numeric = Number(condition.value)
      return Number.isFinite(numeric) ? numeric : null
    }
    return condition.value
  }

  function conditionToNode(condition: FilterCondition): FilterNode | null {
    const field = schema?.fields[condition.field]
    if (!field) return null
    const operand = Filter.field(condition.field)
    if (condition.operator === "is_true") return operand.eq(1)
    if (condition.operator === "is_false") return operand.eq(0)
    if (condition.operator === "null") return operand.null()
    if (condition.operator === "not_null") return operand.notNull()

    const value = filterValue(condition)
    if (value === null || value === "") return null

    switch (condition.operator) {
      case "eq":
        return operand.eq(value)
      case "neq":
        return operand.neq(value)
      case "contains":
        return operand.like(`%${String(value)}%`)
      case "startsWith":
        return operand.like(`${String(value)}%`)
      case "gt":
        return operand.gt(value)
      case "gte":
        return operand.gte(value)
      case "lt":
        return operand.lt(value)
      case "lte":
        return operand.lte(value)
    }
  }

  const conditionsFilter = $derived.by((): FilterNode | undefined => {
    const nodes = filterConditions
      .map((condition) => conditionToNode(condition))
      .filter((node): node is FilterNode => node !== null)
    if (nodes.length === 0) return undefined
    if (nodes.length === 1) return nodes[0]
    return nodes.reduce((left, right, index) =>
      (filterConnectors[index - 1] ?? "and") === "or" ? Filter.or(left, right) : Filter.and(left, right)
    )
  })

  const effectiveFilter = $derived.by((): FilterNode | undefined => {
    if (searchFilter && conditionsFilter) return Filter.and(searchFilter, conditionsFilter)
    return searchFilter ?? conditionsFilter
  })

  let records = $state<Record<string, unknown>[]>([])
  let nextCursor = $state<number | null>(null)
  let selectedIds = $state(new SvelteSet<string>())
  const rangeLabel = $derived.by(() => {
    if (records.length === 0) return "No records"
    return `Showing 1-${records.length}${nextCursor === null ? ` of ${records.length}` : "+"}`
  })

  function clearSelection() {
    selectedIds = new SvelteSet()
  }

  $effect(() => {
    if (!name) return
    if (previousName === name) return
    previousName = name
    searchInput = ""
    search = ""
    filterConditions = []
    filterConnectors = []
    schemaDialogOpen = false
    cursor = 0
    records = []
    nextCursor = null
    lastData = null
    clearSelection()
  })

  $effect(() => {
    if (!schema) return
    if (Object.hasOwn(schema.fields, sortField)) return
    sortField = Object.hasOwn(schema.fields, "name")
      ? "name"
      : Object.hasOwn(schema.fields, "title")
        ? "title"
        : Object.hasOwn(schema.fields, "created")
          ? "created"
          : "id"
    sortOrder = sortField === "created" ? "desc" : "asc"
  })

  $effect(() => {
    const value = searchInput
    const timeout = setTimeout(() => {
      if (value === search) return
      search = value
      resetToList()
    }, 250)
    return () => clearTimeout(timeout)
  })

  const listQuery = createQuery(() =>
    api.listOptions({
      limit: 50,
      after: cursor,
      expand: relationFields,
      filter: effectiveFilter,
      sort: sortField,
      order: sortOrder
    })
  )
  const recordQuery = createQuery(() => ({ ...api.getOneOptions(id ?? ""), enabled: id !== null }))
  const editRecord = $derived(id !== null ? recordQuery.data ?? null : null)

  $effect(() => {
    const data = listQuery.data
    if (!data || data === lastData) return
    lastData = data
    if (cursor === 0) {
      records = data.items
      clearSelection()
    } else {
      records = [...records, ...data.items]
    }
    nextCursor = data.nextCursor
  })

  const schemaFields = $derived(
    schema
      ? Object.entries(schema.fields).map(([fieldName, field]) => ({
          name: fieldName,
          kind: fieldKind(field),
          required: schema.required?.includes(fieldName) === true,
          hidden: isHiddenField(field) || isSeqIdField(field)
        }))
      : []
  )
  const requiredFields = $derived(
    schemaFields.filter((field) => field.required && !field.hidden).map((field) => field.name)
  )

  function formatMetaDate(value: unknown): string {
    if (typeof value !== "string" && typeof value !== "number") return "Not set"
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return String(value)
    const pad = (part: number) => String(part).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  const queryClient = useQueryClient()

  function closeSheet() {
    const searchParams = page.url.searchParams
    searchParams.delete("open")
    searchParams.delete("id")
    goto(`${page.url.pathname}?${searchParams.toString()}`)
  }

  function resetToList() {
    cursor = 0
    records = []
    nextCursor = null
    lastData = null
    clearSelection()
    const searchParams = page.url.searchParams
    searchParams.delete("cursor")
    searchParams.delete("open")
    searchParams.delete("id")
    goto(`${page.url.pathname}?${searchParams.toString()}`)
  }

  function openEdit(recordId: string) {
    const searchParams = page.url.searchParams
    searchParams.set("open", "true")
    searchParams.set("id", recordId)
    goto(`${page.url.pathname}?${searchParams.toString()}`)
  }

  function openNew() {
    const searchParams = page.url.searchParams
    searchParams.set("open", "true")
    searchParams.delete("id")
    goto(`${page.url.pathname}?${searchParams.toString()}`)
  }

  function openConnect() {
    const searchParams = page.url.searchParams
    searchParams.set("connect", "sdk")
    goto(`${page.url.pathname}?${searchParams.toString()}`)
  }

  function changeConnectTab(tab: ConnectTab) {
    const searchParams = page.url.searchParams
    searchParams.set("connect", tab)
    goto(`${page.url.pathname}?${searchParams.toString()}`)
  }

  function closeConnectSheet() {
    const searchParams = page.url.searchParams
    searchParams.delete("connect")
    goto(`${page.url.pathname}?${searchParams.toString()}`)
  }

  function changeSortField(next: string) {
    sortField = next
    resetToList()
  }

  function toggleSortOrder() {
    sortOrder = sortOrder === "asc" ? "desc" : "asc"
    resetToList()
  }

  function clearSearch() {
    searchInput = ""
    search = ""
    resetToList()
  }

  function clearFilters() {
    searchInput = ""
    search = ""
    filterConditions = []
    filterConnectors = []
    resetToList()
  }

  async function handleSubmit(data: FormData | Record<string, unknown>) {
    try {
      if (id !== null) {
        await api.update(id, data)
        toast.success("Record saved")
      } else {
        await api.create(data)
        toast.success("Record created")
      }
      await queryClient.invalidateQueries({ queryKey: api.invalidationKey() })
      resetToList()
    } catch {
      toast.error(id !== null ? "Failed to save record" : "Failed to create record")
    }
  }

  async function handleDelete(recordId: string) {
    try {
      await api.delete(recordId)
      records = records.filter((r) => r["id"] !== recordId)
      toast.success("Record deleted")
    } catch {
      toast.error("Failed to delete record")
    }
  }

  function timestamp(): string {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  }

  async function bulkDelete(ctx: BulkActionContext) {
    const total = ctx.selectedRecords.length
    let succeeded = 0
    let failed = 0
    for (let i = 0; i < total; i++) {
      const record = ctx.selectedRecords[i]
      const recordId = typeof record?.["id"] === "string" ? record["id"] : String(record?.["id"])
      try {
        await api.delete(recordId)
        succeeded++
      } catch {
        failed++
      }
      ctx.onProgress(i + 1, total)
    }
    if (failed === 0) {
      toast.success(`Deleted ${succeeded} records`)
    } else if (succeeded === 0) {
      toast.error(`Failed to delete all ${total} records`)
    } else {
      toast.warning(`Deleted ${succeeded} of ${total}, ${failed} failed`)
    }
  }

  function bulkJson(ctx: BulkActionContext) {
    // Admin requests come back with `x-hidden` columns (auth password hashes) -
    // never write those into a file the operator will download.
    const records = schema
      ? ctx.selectedRecords.map((record) => stripHiddenValues(schema, record))
      : ctx.selectedRecords
    const json = JSON.stringify(records, null, 2)
    const filename = `${name}-${ctx.selectedRecords.length}-${timestamp()}.json`
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
    toast.success(`Downloaded ${ctx.selectedRecords.length} records to ${filename}`)
  }

  const bulkActions = $derived.by((): BulkAction[] => {
    const actions: BulkAction[] = [
      {
        id: "reset",
        label: "Reset",
        icon: IconRefresh,
        run: () => clearSelection()
      }
    ]
    if (schema?.kind !== "view") {
      actions.push({
        id: "delete",
        label: "Delete",
        icon: IconTrash,
        variant: "destructive",
        confirm: (ctx) => ({
          title: `Delete ${ctx.selectedRecords.length} records?`,
          description: "This action cannot be undone."
        }),
        progressLabel: (done, total) => `Deleting ${done}/${total}`,
        run: async (ctx) => {
          await bulkDelete(ctx)
          await queryClient.invalidateQueries({ queryKey: api.invalidationKey() })
          resetToList()
        }
      })
    }
    actions.push({
      id: "json",
      label: "JSON",
      icon: IconDownload,
      run: (ctx) => bulkJson(ctx)
    })
    return actions
  })
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div class="min-w-0">
      <h1 class="truncate text-2xl font-semibold tracking-tight">{collectionTitle}</h1>
      <p class="text-muted-foreground mt-1 text-[0.8125rem]">
        {#if schema}{schema.kind} collection / {Object.keys(schema.fields).length} fields / {schema.kind === "view" ? "read-only" : "writable"} / {/if}
        records and schema for <code class="font-mono">{name}</code>.
      </p>
    </div>
    <div class="flex items-center gap-2">
      {#if schema}
        <Button variant="outline" class="h-11 gap-1.5 px-3 sm:h-9" onclick={openConnect}>
          <IconPlugConnected class="size-4" />
          Connect
        </Button>
        <Button
          variant="outline"
          class="h-11 gap-1.5 px-3 sm:h-9"
          aria-haspopup="dialog"
          onclick={() => (schemaDialogOpen = true)}
        >
          <IconInfoCircle class="size-4" />
          Schema
        </Button>
        {#if schema.kind !== "view"}
          <Button class="bg-foreground text-background hover:bg-foreground/90 h-11 gap-1.5 px-3 sm:h-9" onclick={openNew}>
            <IconPlus class="size-4" />
            New record
          </Button>
        {/if}
      {/if}
    </div>
  </div>

  {#if schemaQuery.isError}
    <div class="border-destructive/30 bg-destructive/5 flex flex-col items-start gap-3 rounded-md border p-5" role="alert">
      <div class="flex items-center gap-2">
        <IconAlertTriangle class="text-destructive size-4" />
        <p class="text-sm font-medium">Could not load the collection schema.</p>
      </div>
      <p class="text-muted-foreground text-sm">The dashboard could not reach the schema endpoint. Try again before editing records.</p>
      <Button variant="outline" class="h-11 sm:h-9" onclick={() => schemaQuery.refetch()}>Retry</Button>
    </div>
  {:else if schemaQuery.isLoading}
    <TableSkeleton columns={columnCount} rows={8} label="Loading collection schema" />
  {:else if !schema}
    <div class="rounded-md border p-6">
      <p class="text-sm font-medium">Collection not found.</p>
      <p class="text-muted-foreground mt-1 text-sm">No collection named <code class="font-mono">{name}</code> is registered on this server.</p>
      <Button variant="outline" class="mt-4 h-11 sm:h-9" onclick={() => goto(resolve("/collections"))}>Back to collections</Button>
    </div>
  {:else}
    <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div class="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
        <div class="relative min-w-0 flex-1 sm:max-w-sm">
          <IconSearch class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            class="h-11 pl-8 pr-9 text-sm sm:h-9"
            placeholder={`Search ${name}...`}
            aria-label={`Search ${name}`}
            bind:value={searchInput}
          />
          {#if searchInput}
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground absolute top-1/2 right-1 flex size-11 -translate-y-1/2 items-center justify-center rounded-sm sm:size-9"
              aria-label="Clear search"
              onclick={clearSearch}
            >
              <IconX class="size-4" />
            </button>
          {/if}
        </div>
        <div class="flex items-center gap-2">
          <Select.Root type="single" value={sortField} onValueChange={(value) => changeSortField(value)}>
            <Select.Trigger class="!h-11 w-36 text-sm sm:!h-9" aria-label={`Sort field: ${fieldLabel(sortField)}`}>
              {fieldLabel(sortField)}
            </Select.Trigger>
            <Select.Content>
              {#each sortableFields as fieldName (fieldName)}
                <Select.Item value={fieldName}>{fieldLabel(fieldName)}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          <Button
            variant="outline"
            class="h-11 gap-1.5 px-2.5 text-sm sm:h-9"
            aria-label={sortOrder === "asc" ? "Sort direction: Asc" : "Sort direction: Desc"}
            onclick={toggleSortOrder}
          >
            {#if sortOrder === "asc"}
              <IconArrowUp class="size-4" />
            {:else}
              <IconArrowDown class="size-4" />
            {/if}
            <span class="hidden sm:inline">{sortOrder === "asc" ? "Asc" : "Desc"}</span>
          </Button>

        </div>
      </div>
      <div class="flex items-center gap-2">
        <p class="text-muted-foreground tabular text-xs" aria-live="polite">
          {rangeLabel}
          {#if listQuery.isFetching}
            <span class="ml-2 inline-flex align-middle"><Spinner class="size-3" /></span>
          {/if}
        </p>
        {#if search || filterConditions.length > 0}
          <Button variant="ghost" class="h-11 sm:h-9" onclick={clearFilters}>Clear filters</Button>
        {/if}
        {#if cursor > 0}
          <Button variant="ghost" class="h-11 sm:h-9" onclick={resetToList}>First page</Button>
        {/if}
      </div>
    </div>

    {#if schema}
      <CollectionFilterBuilder
        {schema}
        conditions={filterConditions}
        connectors={filterConnectors}
        search={search}
        onApply={(nextConditions, nextConnectors) => {
          filterConditions = nextConditions
          filterConnectors = nextConnectors
          resetToList()
        }}
      />
    {/if}

    {#if listQuery.isError}
      <div class="border-destructive/30 bg-destructive/5 flex flex-col items-start gap-3 rounded-md border p-5" role="alert">
        <div class="flex items-center gap-2">
          <IconAlertTriangle class="text-destructive size-4" />
          <p class="text-sm font-medium">Could not load records.</p>
        </div>
        <p class="text-muted-foreground text-sm">The table is not empty - the request failed. Try again without losing your place.</p>
        <Button variant="outline" class="h-11 sm:h-9" onclick={() => listQuery.refetch()}>Retry</Button>
      </div>
    {:else if listQuery.isLoading && records.length === 0}
      <TableSkeleton columns={columnCount} rows={8} label="Loading records" />
    {:else}
      {#key schema}
        <RecordTable
          {schema}
          {records}
          {relationSchemas}
          {bulkActions}
          sortField={sortField}
          sortOrder={sortOrder}
          onSort={changeSortField}
          bind:selectedIds
          onEdit={openEdit}
          onDelete={handleDelete}
          emptyTitle={search || filterConditions.length > 0 ? `No ${name} match the current filters` : `No ${name} yet`}
          emptyDescription={search || filterConditions.length > 0
            ? "Try a different term or filter, or clear the filters to see the full collection."
            : `Create the first record to start using ${name}.`}
          emptyActionLabel={search || filterConditions.length > 0 ? "" : "New record"}
          emptyAction={search || filterConditions.length > 0 ? clearFilters : openNew}
          onLoadMore={() => {
            if (nextCursor !== null) cursor = nextCursor
          }}
          hasMore={nextCursor !== null}
        />
      {/key}
    {/if}

  {/if}
</div>

{#if schema}
  <Dialog.Root bind:open={schemaDialogOpen}>
    <Dialog.Content class="flex max-h-[min(86vh,42rem)] flex-col overflow-hidden p-0 sm:max-w-xl">
      <Dialog.Header class="shrink-0 border-b px-5 py-4 pr-12">
        <Dialog.Title>{collectionTitle} schema</Dialog.Title>
        <Dialog.Description>
          {schema.kind} collection / {Object.keys(schema.fields).length} fields / {schema.kind === "view"
            ? "read-only"
            : "writable"}
        </Dialog.Description>
      </Dialog.Header>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        <div class="space-y-1">
          {#each schemaFields as field (field.name)}
            <div class="hover:bg-muted/40 flex items-center gap-3 rounded-md px-2 py-2">
              <span class="text-muted-foreground flex size-5 shrink-0 items-center justify-center [&_svg]:size-3.5">
                <FieldIcon name={field.name} field={schema.fields[field.name]} />
              </span>
              <div class="min-w-0 flex-1">
                <p class="font-mono text-[0.8125rem]">{field.name}</p>
                <p class="text-muted-foreground text-xs">{field.kind}</p>
              </div>
              <div class="flex flex-wrap justify-end gap-1">
                {#if field.required}<Badge variant="outline">required</Badge>{/if}
                {#if field.hidden}<Badge variant="outline">hidden</Badge>{/if}
              </div>
            </div>
          {/each}
        </div>

        {#if schema.kind === "view" && schema.viewQuery}
          <div class="mt-4">
            <h3 class="text-xs font-medium">View query</h3>
            <pre class="bg-muted/40 mt-2 max-h-48 overflow-auto rounded-md border p-3 font-mono text-[0.6875rem] leading-relaxed">{schema.viewQuery}</pre>
          </div>
        {/if}
      </div>

      <Dialog.Footer class="shrink-0 border-t px-5 py-3">
        <Button variant="outline" class="h-11 w-full sm:h-9" onclick={() => (schemaDialogOpen = false)}>Close</Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}

<Sheet.Root open={showSheet} onOpenChange={(value) => !value && closeSheet()}>
  <Sheet.Content side="right" class="min-w-full md:min-w-lg overflow-y-auto">
    <Sheet.Header class="bg-card sticky top-0 z-30 border-b">
      <Sheet.Title>{id ? "Edit record" : "New record"}</Sheet.Title>
      <Sheet.Description class="font-mono">{name}{id ? ` / ${id.slice(0, 8)}` : ""}</Sheet.Description>
    </Sheet.Header>
    {#if schema}
      {#if id !== null && recordQuery.isLoading}
        <div class="mt-4 space-y-5 px-5 py-4" role="status" aria-live="polite" aria-busy="true" aria-label="Loading record">
          {#each { length: 4 } as _, index (index)}
            <div class="space-y-2">
              <Skeleton class="h-3 w-24" />
              <Skeleton class="h-10 w-full" />
            </div>
          {/each}
        </div>
      {:else if id !== null && recordQuery.isError}
        <div class="border-destructive/30 bg-destructive/5 m-5 flex flex-col items-start gap-3 rounded-md border p-4" role="alert">
          <p class="text-sm font-medium">Could not load this record.</p>
          <p class="text-muted-foreground text-xs">The record request failed; the record may still exist.</p>
          <Button variant="outline" class="h-11 sm:h-9" onclick={() => recordQuery.refetch()}>Retry</Button>
        </div>
      {:else if id !== null && !editRecord}
        <p class="text-muted-foreground px-5 py-4">Record not found.</p>
      {:else}
        <div class="mt-4 px-5">
          {#key id}
            <RecordForm {schema} record={editRecord} onSubmit={handleSubmit} />
          {/key}
        </div>
      {/if}
    {/if}

    {#if schema && !(id !== null && (recordQuery.isLoading || recordQuery.isError || !editRecord))}
      <div class="mt-6 border-t px-5 py-4">
        <h3 class="text-xs font-medium">Record details</h3>
        <dl class="text-muted-foreground mt-2 space-y-2 text-xs">
          <div class="flex justify-between gap-3">
            <dt>Endpoint</dt>
            <dd class="text-right">
              <code class="font-mono break-all">
                {id ? `PATCH /api/collections/${name}/${id}` : `POST /api/collections/${name}`}
              </code>
            </dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt>Required</dt>
            <dd class="text-right">{requiredFields.length > 0 ? requiredFields.join(", ") : "None"}</dd>
          </div>
          {#if editRecord}
            <div class="flex justify-between gap-3">
              <dt>ID</dt>
              <dd class="truncate font-mono">{String(editRecord["id"] ?? "Not set")}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt>Created</dt>
              <dd class="text-right">{formatMetaDate(editRecord["created"])}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt>Updated</dt>
              <dd class="text-right">{formatMetaDate(editRecord["updated"])}</dd>
            </div>
          {:else}
            <p class="pt-1 leading-relaxed">ID, created and updated values are assigned by the server when this record is created.</p>
          {/if}
        </dl>
        {#if editRecord}
          <details class="mt-4 border-t pt-3" open>
            <summary class="text-muted-foreground hover:text-foreground cursor-pointer text-xs">Raw JSON</summary>
            <pre class="bg-muted/40 mt-2 max-h-48 overflow-auto rounded-md border p-3 font-mono text-[0.6875rem] leading-relaxed">{JSON.stringify(stripHiddenValues(schema, editRecord), null, 2)}</pre>
          </details>
        {/if}
      </div>
    {/if}

    <Sheet.Footer class="bg-card sticky bottom-0 z-30 flex flex-row border-t">
      <Button class="!h-11 flex-1" variant="outline" onclick={closeSheet} disabled={recordFormStore.isLoading}>Cancel</Button>
      <Button type="submit" class="bg-foreground text-background hover:bg-foreground/90 !h-11 flex-1" form="record-form" disabled={(id !== null && !editRecord) || recordFormStore.isLoading}>
        {#if recordFormStore.isLoading}
          <Spinner />
        {/if}
        {id ? "Save changes" : "Create record"}
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>

{#if schema !== null}
  <ConnectSheet
    open={connectParam !== null}
    tab={connectTab}
    {schema}
    allSchemas={schemaQuery.data ?? []}
    onTabChange={changeConnectTab}
    onClose={closeConnectSheet}
  />
{/if}
