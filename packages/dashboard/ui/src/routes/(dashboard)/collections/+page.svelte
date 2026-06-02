<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import { client } from "$lib/client.js"
  import * as Table from "$lib/components/ui/table/index.js"
  import { Badge } from "$lib/components/ui/badge/index.js"
  import { base } from "$app/paths"

  const schemaQuery = createQuery(() => ({ queryKey: ["schema"], queryFn: () => client.schema() }))

  const kindVariant = (kind: string) =>
    kind === "auth" ? "secondary" : kind === "view" ? "outline" : "default"
</script>

<div class="space-y-4">
  <h1 class="text-2xl font-bold">Collections</h1>

  {#if schemaQuery.isLoading}
    <p class="text-muted-foreground">Loading…</p>
  {:else if schemaQuery.data}
    <div class="rounded-md border">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Name</Table.Head>
            <Table.Head>Kind</Table.Head>
            <Table.Head>Fields</Table.Head>
            <Table.Head>Actions</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each schemaQuery.data as col (col.name)}
            <Table.Row>
              <Table.Cell class="font-mono text-sm font-medium">{col.name}</Table.Cell>
              <Table.Cell>
                <Badge variant={kindVariant(col.kind)} class="text-xs">{col.kind}</Badge>
              </Table.Cell>
              <Table.Cell class="text-sm text-muted-foreground">
                {Object.keys(col.fields).length} fields
              </Table.Cell>
              <Table.Cell>
                <a href="{base}/collections/{col.name}" class="text-sm text-primary hover:underline">
                  View records →
                </a>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  {/if}
</div>
