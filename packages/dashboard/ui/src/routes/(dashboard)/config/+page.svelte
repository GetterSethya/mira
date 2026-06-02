<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import { client } from "$lib/client.js"
  import * as Table from "$lib/components/ui/table/index.js"

  const configQuery = createQuery(() => ({ queryKey: ["config"], queryFn: () => client.config() }))
</script>

<div class="space-y-4">
  <h1 class="text-2xl font-bold">Config</h1>
  <p class="text-sm text-muted-foreground">Read-only server configuration.</p>

  {#if configQuery.isLoading}
    <p class="text-muted-foreground">Loading…</p>
  {:else if configQuery.data}
    <div class="rounded-md border max-w-2xl">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head class="w-48">Key</Table.Head>
            <Table.Head>Value</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each configQuery.data.keys as key (key)}
            <Table.Row>
              <Table.Cell class="font-mono text-sm font-medium">{key}</Table.Cell>
              <Table.Cell class="font-mono text-sm text-muted-foreground">
                {String(configQuery.data.config[key] ?? "—")}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  {/if}
</div>
