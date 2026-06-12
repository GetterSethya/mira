<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query"
  import { mira } from "$lib/mira.js"
  import * as Table from "$lib/components/ui/table/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import { Input } from "$lib/components/ui/input/index.js"
  import * as Card from "$lib/components/ui/card/index.js"
  import { Separator } from "$lib/components/ui/separator/index.js"
  import { toast } from "svelte-sonner"
  import { base } from "$app/paths"

  const queryClient = useQueryClient()
  const adminsQuery = createQuery(() => ({ queryKey: ["superadmins"], queryFn: () => mira.superadmin.getList().raw() }))

  const isLast = $derived((adminsQuery.data?.items.length ?? 0) <= 1)

  let deleteId = $state<string | null>(null)
  let deleting = $state(false)

  async function confirmDelete() {
    if (!deleteId) return
    deleting = true
    try {
      await mira.superadmin.delete().raw(deleteId)
      await queryClient.invalidateQueries({ queryKey: ["superadmins"] })
      toast.success("Superadmin deleted")
    } catch {
      toast.error("Delete failed")
    } finally {
      deleting = false
      deleteId = null
    }
  }

  let email = $state("")
  let adding = $state(false)

  async function handleAdd() {
    if (!email) return
    adding = true
    try {
      await mira.superadmin.create().raw({ email, emailVerified: false, name: "" })
      await queryClient.invalidateQueries({ queryKey: ["superadmins"] })
      email = ""
      toast.success("Superadmin added")
    } catch {
      toast.error("Failed to add superadmin")
    } finally {
      adding = false
    }
  }
</script>

<div class="space-y-6 max-w-2xl">
  <div>
    <a href="{base}/settings" class="text-sm text-muted-foreground hover:underline">← Settings</a>
    <h1 class="text-2xl font-bold mt-1">Superadmins</h1>
  </div>

  {#if adminsQuery.isLoading}
    <p class="text-muted-foreground">Loading…</p>
  {:else if adminsQuery.data}
    <div class="rounded-md border">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Email</Table.Head>
            <Table.Head>Created</Table.Head>
            <Table.Head class="w-24"></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each adminsQuery.data.items as admin (admin.id)}
            <Table.Row>
              <Table.Cell class="font-medium">{admin.email}</Table.Cell>
              <Table.Cell class="text-sm text-muted-foreground">
                {new Date(admin.created).toLocaleDateString()}
              </Table.Cell>
              <Table.Cell>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={isLast}
                  title={isLast ? "Cannot delete the last superadmin" : "Delete"}
                  onclick={() => (deleteId = admin.id)}
                >
                  Delete
                </Button>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  {/if}

  <Separator />

  <Card.Root>
    <Card.Header>
      <Card.Title class="text-sm">Add superadmin</Card.Title>
    </Card.Header>
    <Card.Content>
      <div class="flex flex-col gap-4">
        <Field.Field>
          <Field.Label>Email</Field.Label>
          <Input type="email" bind:value={email} placeholder="admin@example.com" />
        </Field.Field>
        <Button onclick={handleAdd} disabled={adding || !email}>
          {adding ? "Adding…" : "Add superadmin"}
        </Button>
      </div>
    </Card.Content>
  </Card.Root>
</div>

<AlertDialog.Root open={deleteId !== null} onOpenChange={(o) => { if (!o) deleteId = null }}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete superadmin?</AlertDialog.Title>
      <AlertDialog.Description>
        This will permanently remove the superadmin account. This action cannot be undone.
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
