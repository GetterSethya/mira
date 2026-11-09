<script lang="ts">
  import * as Table from "$lib/components/ui/table/index.js"
  import { Skeleton } from "$lib/components/ui/skeleton/index.js"

  const {
    rows = 8,
    columns = 4,
    label = "Loading records"
  }: { rows?: number; columns?: number; label?: string } = $props()

  function widthFor(row: number, col: number) {
    return `${50 + ((row * 7 + col * 13) % 40)}%`
  }
</script>

<div class="space-y-2 md:hidden" role="status" aria-live="polite" aria-label={label}>
  {#each { length: Math.min(rows, 6) } as _, row (row)}
    <div class="rounded-md border p-4">
      <Skeleton class="h-4 w-36" />
      <Skeleton class="mt-2 h-3 w-52" />
      <Skeleton class="mt-4 h-3 w-24" />
    </div>
  {/each}
</div>

<div class="hidden rounded-md border md:block" role="status" aria-live="polite" aria-label={label}>
  <Table.Root>
    <Table.Header>
      <Table.Row>
        {#each { length: columns } as _, col (col)}
          <Table.Head>
            <Skeleton class="h-3 w-16" />
          </Table.Head>
        {/each}
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#each { length: rows } as _, row (row)}
        <Table.Row>
          {#each { length: columns } as _, col (col)}
            <Table.Cell>
              <Skeleton class="h-4 max-w-(--skeleton-width)" style="--skeleton-width: {widthFor(row, col)};" />
            </Table.Cell>
          {/each}
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
</div>
