<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import { mira } from "$lib/mira.js"
  import * as Table from "$lib/components/ui/table/index.js"
  import { Badge } from "$lib/components/ui/badge/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import TableSkeleton from "$lib/components/TableSkeleton.svelte"
  import { resolve } from "$app/paths"
  import { IconAlertTriangle } from "@tabler/icons-svelte"

  const schemaQuery = createQuery(() => ({ queryKey: ["schema"], queryFn: () => mira.telemetry.getSchema().raw() }))

  const kindVariant = (kind: string) => (kind === "auth" ? "secondary" : "outline")
  const counts = $derived.by(() => {
    const data = schemaQuery.data ?? []
    return {
      total: data.length,
      base: data.filter((collection) => collection.kind === "base").length,
      auth: data.filter((collection) => collection.kind === "auth").length,
      view: data.filter((collection) => collection.kind === "view").length
    }
  })
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Collections</h1>
      <p class="text-muted-foreground mt-1 text-sm">
        The live schema behind this server. Open a collection to inspect, create or edit its records.
      </p>
    </div>
    {#if schemaQuery.data}
      <p class="text-muted-foreground tabular text-xs">
        {counts.total} collections
        <span class="text-border px-1" aria-hidden="true">/</span>
        {counts.base} base
        <span class="text-border px-1" aria-hidden="true">/</span>
        {counts.auth} auth
        {#if counts.view > 0}
          <span class="text-border px-1" aria-hidden="true">/</span>
          {counts.view} view
        {/if}
      </p>
    {/if}
  </div>

  {#if schemaQuery.isError}
    <div class="border-destructive/30 bg-destructive/5 flex flex-col items-start gap-3 rounded-md border p-5" role="alert">
      <div class="flex items-center gap-2">
        <IconAlertTriangle class="text-destructive size-4" />
        <p class="text-sm font-medium">Could not load the collection schema.</p>
      </div>
      <p class="text-muted-foreground text-sm">The dashboard could not reach <code class="font-mono">GET /api/_schema</code>.</p>
      <Button variant="outline" class="h-11 sm:h-9" onclick={() => schemaQuery.refetch()}>Retry</Button>
    </div>
  {:else if schemaQuery.isLoading}
    <TableSkeleton columns={4} rows={4} />
  {:else if schemaQuery.data && schemaQuery.data.length > 0}
    <div class="overflow-x-auto rounded-md border">
      <Table.Root>
        <Table.Caption class="sr-only">Collections registered on this server</Table.Caption>
        <Table.Header class="bg-background sticky top-0 z-10">
          <Table.Row>
            <Table.Head scope="col">Name</Table.Head>
            <Table.Head scope="col" class="w-32">Kind</Table.Head>
            <Table.Head scope="col" class="w-28">Fields</Table.Head>
            <Table.Head scope="col" class="w-44">Actions</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each schemaQuery.data as col (col.name)}
            <Table.Row>
              <Table.Cell class="font-mono text-sm font-medium">{col.name}</Table.Cell>
              <Table.Cell>
                <Badge variant={kindVariant(col.kind)} class="text-xs">{col.kind}</Badge>
              </Table.Cell>
              <Table.Cell class="text-muted-foreground text-sm">
                {Object.keys(col.fields).length} fields
              </Table.Cell>
              <Table.Cell class="w-44">
                <a
                  href={resolve(`/collections/${col.name}`)}
                  class="text-primary inline-flex items-center gap-1 text-sm whitespace-nowrap hover:underline"
                >
                  View records
                  <span aria-hidden="true">-&gt;</span>
                </a>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  {:else}
    <div class="rounded-md border px-6 py-12 text-center">
      <p class="text-sm font-medium">No collections registered.</p>
      <p class="text-muted-foreground mt-1 text-sm">Define a collection in code and boot the server to see it here.</p>
    </div>
  {/if}

  <section class="border-t pt-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-sm font-medium">Schema source</h2>
        <p class="text-muted-foreground mt-1 max-w-2xl text-xs leading-relaxed">
          This directory is built from the live <code class="font-mono">GET /api/_schema</code> response. Add a collection in code, boot the server, and it appears here after migrations run.
        </p>
      </div>
    </div>
    <div class="bg-muted/30 mt-3 rounded-md border px-3 py-2">
      <code class="text-muted-foreground font-mono text-[0.6875rem]">GET /api/_schema -&gt; CollectionSchema[]</code>
    </div>
  </section>

  <section class="border-t pt-6">
    <h2 class="text-sm font-medium">Operations</h2>
    <p class="text-muted-foreground mt-1 text-xs">The runtime surfaces that sit beside the collection data.</p>
    <dl class="text-muted-foreground mt-3 grid gap-x-8 gap-y-0 text-[0.8125rem] sm:grid-cols-2">
      <div class="flex items-baseline justify-between gap-4 border-b py-2">
        <dt><a href={resolve("/logs")} class="hover:text-foreground transition-colors">Logs</a></dt>
        <dd class="text-right">Application log stream</dd>
      </div>
      <div class="flex items-baseline justify-between gap-4 border-b py-2">
        <dt><a href={resolve("/spans")} class="hover:text-foreground transition-colors">Spans</a></dt>
        <dd class="text-right">Request traces and timings</dd>
      </div>
      <div class="flex items-baseline justify-between gap-4 border-b py-2">
        <dt><a href={resolve("/crons")} class="hover:text-foreground transition-colors">Cron</a></dt>
        <dd class="text-right">Scheduled job state</dd>
      </div>
      <div class="flex items-baseline justify-between gap-4 border-b py-2">
        <dt><a href={resolve("/settings")} class="hover:text-foreground transition-colors">Settings</a></dt>
        <dd class="text-right">App and account config</dd>
      </div>
    </dl>
  </section>
</div>
