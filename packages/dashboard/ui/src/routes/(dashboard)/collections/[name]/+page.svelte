<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query"
  import { page } from "$app/state"
  import { mira } from "$lib/mira.js"
  import { makeCollectionApi } from "$lib/collection-client.js"
  import RecordTable from "$lib/components/RecordTable.svelte"
  import RecordForm from "$lib/components/RecordForm.svelte"
  import TableSkeleton from "$lib/components/TableSkeleton.svelte"
  import { Button } from "$lib/components/ui/button/index.js"
  import * as Sheet from "$lib/components/ui/sheet/index.js"
  import { toast } from "svelte-sonner"
  import { goto } from "$app/navigation"
  import { Spinner } from "$lib/components/ui/spinner"
  import { recordFormStore } from "$lib/stores/record-form-store.svelte"

  const schemaQuery = createQuery(() => ({ queryKey: ["schema"], queryFn: () => mira.telemetry.getSchema().raw() }))

  const name = $derived(page.params["name"] ?? "")
  const cursor = $derived(Number(page.url.searchParams.get("cursor") || "0"))
  const showSheet = $derived(page.url.searchParams.get("open") !== null)
  const id = $derived(page.url.searchParams.get("id"))
  const schema = $derived(schemaQuery.data?.find((s) => s.name === name) ?? null)
  const api = $derived(makeCollectionApi(name))
  const columnCount = $derived(schema ? Object.keys(schema.fields).length + 1 : 5)

  const listQuery = createQuery(() => api.listOptions({ limit: 50, after: cursor }))
  const recordQuery = createQuery(() => ({ ...api.getOneOptions(id ?? ""), enabled: id !== null }))
  const editRecord = $derived(id !== null ? recordQuery.data ?? null : null)

  let records = $state<Record<string, unknown>[]>([])
  let nextCursor = $state<number | null>(null)

  $effect(() => {
    const data = listQuery.data
    if (data) {
      records = !cursor ? data.items : [...records, ...data.items]
      nextCursor = data.nextCursor
    }
  })

  const queryClient = useQueryClient()

  function closeSheet() {
    const searchParams = page.url.searchParams
    searchParams.delete("open")
    searchParams.delete("id")
    goto(`${page.url.pathname}?${searchParams.toString()}`)
  }

  function resetToList() {
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

  async function handleSubmit(data: FormData | Record<string, unknown>) {
    try {
      if (id !== null) {
        await api.update(id, data as Record<string, unknown>)
        toast.success("Record saved")
      } else {
        await api.create(data as Record<string, unknown>)
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
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold font-mono">{name}</h1>
    {#if schema}
      <Button
        onclick={() => {
          const searchParams = page.url.searchParams
          searchParams.set("open", "true")
          searchParams.delete("id")
          goto(`${page.url.pathname}?${searchParams.toString()}`)
        }}
      >
        New record
      </Button>
    {/if}
  </div>

  {#if schemaQuery.isLoading}
    <TableSkeleton columns={columnCount} rows={8} />
  {:else if !schema}
    <p class="text-muted-foreground">Collection not found.</p>
  {:else if listQuery.isLoading && records.length === 0}
    <TableSkeleton columns={columnCount} rows={8} />
  {:else}
    {#key schema}
      <RecordTable
        {schema}
        {records}
        onEdit={openEdit}
        onDelete={handleDelete}
        onLoadMore={() => {
          if (nextCursor !== null) {
            const searchParams = page.url.searchParams
            searchParams.set("cursor", nextCursor.toString())
            goto(`${page.url.pathname}?${searchParams.toString()}`)
          }
        }}
        hasMore={nextCursor !== null}
      />
    {/key}
  {/if}
</div>

<Sheet.Root open={showSheet} onOpenChange={(value) => !value && closeSheet()}>
  <Sheet.Content showCloseButton={false} side="right" class="min-w-full md:min-w-lg overflow-y-auto">
    <Sheet.Header class="sticky top-0 bg-card z-30 border-b">
      <Sheet.Title>{id ? `Edit ${name} record` : `New ${name} record`}</Sheet.Title>
    </Sheet.Header>
    {#if schema}
      {#if id !== null && recordQuery.isLoading}
        <p class="text-muted-foreground px-5 py-4">Loading…</p>
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

    <Sheet.Footer class="flex flex-row sticky bottom-0 bg-card border-t z-30">
      <Button class="flex-1" variant="outline" onclick={closeSheet}>Cancel</Button>
      <Button type="submit" class="flex-1" form="record-form" disabled={id !== null && !editRecord}>
        {#if recordFormStore.isLoading}
          <Spinner />
        {/if}
        {id ? "Save" : "Submit"}
      </Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
