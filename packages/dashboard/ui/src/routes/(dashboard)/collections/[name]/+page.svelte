<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query"
  import { page } from "$app/stores"
  import { client } from "$lib/client.js"
  import { makeCollectionApi } from "$lib/collection-client.js"
  import RecordTable from "$lib/components/RecordTable.svelte"
  import RecordForm from "$lib/components/RecordForm.svelte"
  import { Button } from "$lib/components/ui/button/index.js"
  import * as Sheet from "$lib/components/ui/sheet/index.js"
  import { toast } from "svelte-sonner"

  const name = $derived($page.params["name"] ?? "")
  const schemaQuery = createQuery(() => ({ queryKey: ["schema"], queryFn: () => client.schema() }))
  const schema = $derived(schemaQuery.data?.find((s) => s.name === name) ?? null)

  const api = $derived(makeCollectionApi(name))
  let cursor = $state<number | undefined>(undefined)
  const listQuery = createQuery(() => api.listOptions({ limit: 50, after: cursor }))

  let records = $state<Record<string, unknown>[]>([])
  let hasMore = $state(false)

  $effect(() => {
    const items = listQuery.data?.items
    if (items) {
      if (cursor === undefined) {
        records = items
      } else {
        records = [...records, ...items]
      }
      hasMore = items.length === 50
    }
  })

  let showCreate = $state(false)
  const queryClient = useQueryClient()

  async function handleCreate(data: FormData | Record<string, unknown>) {
    try {
      await api.create(data as Record<string, unknown>)
      await queryClient.invalidateQueries({ queryKey: api.invalidationKey() })
      cursor = undefined
      showCreate = false
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
      <Button onclick={() => (showCreate = true)}>New record</Button>
    {/if}
  </div>

  {#if !schema}
    <p class="text-muted-foreground">Collection not found.</p>
  {:else if listQuery.isLoading && records.length === 0}
    <p class="text-muted-foreground">Loading…</p>
  {:else}
    <RecordTable
      {schema}
      {records}
      collectionName={name}
      onDelete={handleDelete}
      onLoadMore={() => {
        const last = records[records.length - 1]
        if (last) cursor = Number(last["seqId"])
      }}
      {hasMore}
    />
  {/if}
</div>

<Sheet.Root open={showCreate} onOpenChange={(o) => (showCreate = o)}>
  <Sheet.Content side="right" class="w-[480px] overflow-y-auto">
    <Sheet.Header>
      <Sheet.Title>New {name} record</Sheet.Title>
    </Sheet.Header>
    {#if schema}
      <div class="mt-4">
        <RecordForm {schema} record={null} onSubmit={handleCreate} />
      </div>
    {/if}
  </Sheet.Content>
</Sheet.Root>
