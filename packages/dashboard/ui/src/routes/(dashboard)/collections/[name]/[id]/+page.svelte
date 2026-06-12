<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query"
  import { page } from "$app/stores"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { mira } from "$lib/mira.js"
  import { makeCollectionApi } from "$lib/collection-client.js"
  import RecordForm from "$lib/components/RecordForm.svelte"
  import { Button } from "$lib/components/ui/button/index.js"
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js"
  import { toast } from "svelte-sonner"

  const name = $derived($page.params["name"] ?? "")
  const id = $derived($page.params["id"] ?? "")

  const schemaQuery = createQuery(() => ({ queryKey: ["schema"], queryFn: () => mira.telemetry.getSchema().raw() }))
  const schema = $derived(schemaQuery.data?.find((s) => s.name === name) ?? null)
  const api = $derived(makeCollectionApi(name))
  const recordQuery = createQuery(() => api.getOneOptions(id))
  const queryClient = useQueryClient()

  let showDelete = $state(false)
  let deleting = $state(false)

  async function handleSave(data: FormData | Record<string, unknown>) {
    try {
      await api.update(id, data as Record<string, unknown>)
      await queryClient.invalidateQueries({ queryKey: api.invalidationKey() })
      toast.success("Record saved")
    } catch {
      toast.error("Failed to save")
    }
  }

  async function handleDelete() {
    deleting = true
    try {
      await api.delete(id)
      toast.success("Record deleted")
      goto(`${base}/collections/${name}`)
    } catch {
      toast.error("Failed to delete")
    } finally {
      deleting = false
      showDelete = false
    }
  }
</script>

<div class="space-y-6 max-w-2xl">
  <div class="flex items-center justify-between">
    <div>
      <a href="{base}/collections/{name}" class="text-sm text-muted-foreground hover:underline">← {name}</a>
      <h1 class="text-xl font-bold font-mono mt-1">{id}</h1>
    </div>
    <Button variant="destructive" onclick={() => (showDelete = true)}>Delete</Button>
  </div>

  {#if recordQuery.isLoading || schemaQuery.isLoading}
    <p class="text-muted-foreground">Loading…</p>
  {:else if schema && recordQuery.data}
    <RecordForm {schema} record={recordQuery.data} onSubmit={handleSave} />
  {:else}
    <p class="text-muted-foreground">Record not found.</p>
  {/if}
</div>

<AlertDialog.Root open={showDelete} onOpenChange={(o) => (showDelete = o)}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete record?</AlertDialog.Title>
      <AlertDialog.Description>
        Permanently delete <code>{id}</code> from <code>{name}</code>. This cannot be undone.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={handleDelete} disabled={deleting}>
        {deleting ? "Deleting…" : "Delete"}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
