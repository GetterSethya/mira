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
  const showSheet = $derived(page.url.searchParams.get("open"))
  const id = $derived(page.url.searchParams.get("id"))
  const schema = $derived(schemaQuery.data?.find((s) => s.name === name) ?? null)
  const api = $derived(makeCollectionApi(name))
  const columnCount = $derived(schema ? Object.keys(schema.fields).length + 1 : 5)

  const listQuery = createQuery(() => api.listOptions({ limit: 50, after: cursor }))

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

  async function handleCreate(data: FormData | Record<string, unknown>) {
    try {
      await api.create(data as Record<string, unknown>)
      await queryClient.invalidateQueries({ queryKey: api.invalidationKey() })
      const searchParams = page.url.searchParams
      searchParams.delete("cursor")
      searchParams.delete("open")
      goto(`${page.url.pathname}?${searchParams.toString()}`)
      toast.success("Record created")
    } catch {
      toast.error("Failed to create record")
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.delete(id)
      records = records.filter((r) => r["id"] !== id)
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
        collectionName={name}
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

<Sheet.Root
  open={!!showSheet}
  onOpenChange={(value) => {
    const searchParams = page.url.searchParams
    if (!value) {
      searchParams.delete("open")
      searchParams.delete("id")
    }
    goto(`${page.url.pathname}?${searchParams.toString()}`)
  }}
>
  <Sheet.Content showCloseButton={false} side="right" class="min-w-full md:min-w-lg overflow-y-auto">
    <Sheet.Header class="sticky top-0 bg-card z-30 border-b">
      <Sheet.Title>New {name} record</Sheet.Title>
    </Sheet.Header>
    {#if schema}
      <div class="mt-4 px-5">
        <RecordForm {schema} record={null} onSubmit={handleCreate} />
      </div>
    {/if}

    <Sheet.Footer class="flex flex-row sticky bottom-0 bg-card border-t z-30">
      <Button class="flex-1" variant="destructive">Cancel</Button>
      <Button type="submit" class="flex-1" form="record-form">
        {#if recordFormStore.isLoading}
          <Spinner />
        {/if}
        {id ? "Save" : "Submit"}</Button
      >
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
