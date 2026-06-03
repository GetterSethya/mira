<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import { client } from "$lib/client.js"
  import * as Card from "$lib/components/ui/card/index.js"
  import { Badge } from "$lib/components/ui/badge/index.js"
  import { resolve } from "$app/paths"

  const schemaQuery = createQuery(() => ({ queryKey: ["schema"], queryFn: () => client.schema() }))

  const logsQuery = createQuery(() => ({
    queryKey: ["logs", "recent"],
    queryFn: () => client.logs({ limit: 5, offset: 0 })
  }))

  const spansQuery = createQuery(() => ({ queryKey: ["spans", "recent"], queryFn: () => client.spans({ limit: 1 }) }))

  const levelVariant = (level: string) =>
    level === "ERROR" ? "destructive" : level === "WARNING" ? "secondary" : "outline"
</script>

<div class="space-y-6">
  <h1 class="text-2xl font-bold">Overview</h1>

  <div class="grid gap-4 md:grid-cols-3">
    {#if schemaQuery.isSuccess}
      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Title class="text-sm font-medium">Collections</Card.Title>
        </Card.Header>
        <Card.Content>
          <div class="text-3xl font-bold">{schemaQuery.data.length}</div>
          <div class="mt-2 flex flex-wrap gap-1">
            {#each ["base", "auth", "view"] as kind}
              {@const count = schemaQuery.data.filter((c) => c.kind === kind).length}
              {#if count > 0}
                <Badge variant="outline" class="text-xs">{kind}: {count}</Badge>
              {/if}
            {/each}
          </div>
        </Card.Content>
        <Card.Footer class="mt-auto">
          <a href={resolve("/collections")} class="mt-3 text-xs text-primary hover:underline block mt-auto"
            >View all →</a
          >
        </Card.Footer>
      </Card.Root>
    {:else if schemaQuery.isLoading}
      <span>Loading...</span>
    {/if}

    {#if logsQuery.isSuccess}
      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Title class="text-sm font-medium">Recent Logs</Card.Title>
        </Card.Header>
        <Card.Content>
          <div class="flex flex-col gap-1.5">
            {#each logsQuery.data.logs as log (log.id)}
              <div class="flex items-start gap-2 text-xs">
                <Badge variant={levelVariant(log.level)} class="text-[10px] px-1 py-0 shrink-0">{log.level}</Badge>
                <span class="truncate text-muted-foreground">{log.message}</span>
              </div>
            {/each}
          </div>
        </Card.Content>
        <Card.Footer class="mt-auto">
          <a href={resolve("/logs")} class="mt-3 text-xs text-primary hover:underline block">View all →</a>
        </Card.Footer>
      </Card.Root>
    {:else if logsQuery.isPending}
      <span>Loading...</span>
    {/if}

    {#if spansQuery.isSuccess}
      <Card.Root>
        <Card.Header class="pb-2">
          <Card.Title class="text-sm font-medium">Recent Spans</Card.Title>
        </Card.Header>
        <Card.Content>
          <div class="flex flex-col gap-1.5">
            {#each spansQuery.data.spans as span (span.id)}
              <div class="flex items-center gap-2 text-xs">
                <Badge
                  variant={span.status === "error" ? "destructive" : "secondary"}
                  class="text-[10px] px-1 py-0 shrink-0">{span.status}</Badge
                >
                <span class="truncate">{span.name}</span>
                <span class="ml-auto text-muted-foreground shrink-0">{span.durationMs.toFixed(1)}ms</span>
              </div>
            {/each}
          </div>
        </Card.Content>
        <Card.Footer class="mt-auto">
          <a href={resolve("/spans")} class="mt-3 text-xs text-primary hover:underline block">View all →</a>
        </Card.Footer>
      </Card.Root>
    {:else if spansQuery.isPending}
      <span>Loading...</span>
    {/if}
  </div>
</div>
