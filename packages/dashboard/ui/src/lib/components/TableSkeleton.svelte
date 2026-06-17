<script lang="ts">
  import * as Table from "$lib/components/ui/table/index.js"
  import { Skeleton } from "$lib/components/ui/skeleton/index.js"

  const { rows = 8, columns = 4 }: { rows?: number; columns?: number } = $props()

  function widthFor(row: number, col: number) {
    return `${50 + ((row * 7 + col * 13) % 40)}%`
  }
</script>

<div class="rounded-md border">
  <Table.Root>
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
