<script lang="ts">
  import * as Table from "$lib/components/ui/table/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js"
  import type { CollectionSchema } from "$lib/client.js"
  import { isSystemField } from "$lib/schema.js"
  import { base } from "$app/paths"

  const {
    schema,
    records,
    collectionName,
    onDelete,
    onLoadMore,
    hasMore = false,
  }: {
    schema: CollectionSchema
    records: Record<string, unknown>[]
    collectionName: string
    onDelete: (id: string) => Promise<void>
    onLoadMore?: () => void
    hasMore?: boolean
  } = $props()

  const systemCols = ["id", "seqId", "created", "updated"]
  const allCols = $derived([
    ...systemCols.filter((c) => c in (schema.fields)),
    ...Object.keys(schema.fields).filter((c) => !isSystemField(c)),
  ])

  let deleteId = $state<string | null>(null)
  let deleting = $state(false)

  async function confirmDelete() {
    if (!deleteId) return
    deleting = true
    await onDelete(deleteId)
    deleting = false
    deleteId = null
  }
</script>

<div class="rounded-md border overflow-x-auto">
  <Table.Root>
    <Table.Header>
      <Table.Row>
        {#each allCols as col}
          <Table.Head class={isSystemField(col) ? "text-muted-foreground" : ""}>{col}</Table.Head>
        {/each}
        <Table.Head class="w-24">Actions</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#each records as record (record["id"])}
        <Table.Row
          class="cursor-pointer hover:bg-muted/50"
          onclick={() => { if (typeof record["id"] === "string") window.location.href = `${base}/collections/${collectionName}/${record["id"]}` }}
        >
          {#each allCols as col}
            <Table.Cell class="max-w-[200px] truncate text-sm">
              {#if record[col] === null || record[col] === undefined}
                <span class="text-muted-foreground">—</span>
              {:else}
                {String(record[col]).slice(0, 80)}
              {/if}
            </Table.Cell>
          {/each}
          <Table.Cell onclick={(e) => e.stopPropagation()}>
            <Button
              variant="destructive"
              size="sm"
              onclick={() => { deleteId = String(record["id"]) }}
            >
              Delete
            </Button>
          </Table.Cell>
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

<AlertDialog.Root open={deleteId !== null} onOpenChange={(o) => { if (!o) deleteId = null }}>
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
