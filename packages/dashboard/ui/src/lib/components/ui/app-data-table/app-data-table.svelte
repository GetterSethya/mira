<script lang="ts" module>
  import { getCoreRowModel, type ColumnDef } from "@tanstack/table-core"
  import { createSvelteTable } from "../data-table"
  import * as Table from "$lib/components/ui/table"
  import FlexRender from "../data-table/flex-render.svelte"
  import { cn } from "$lib/utils"

  export type DataTableProps<TData, TValue> = {
    columns: ColumnDef<TData, TValue>[]
    data: TData[]
  }
</script>

<script lang="ts" generics="TData, TValue">
  const { data, columns }: DataTableProps<TData, TValue> = $props()

  const getColumns = () => columns

  const table = createSvelteTable({
    get data() {
      return data
    },
    columns: getColumns(),
    getCoreRowModel: getCoreRowModel()
  })
</script>

<div class="rounded-md border">
  <Table.Root>
    <Table.Header>
      {#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
        <Table.Row>
          {#each headerGroup.headers as header (header.id)}
            {@const size = header.getSize()}
            <Table.Head colspan={header.colSpan} class={cn(size === 20 && "w-1")}>
              {#if !header.isPlaceholder}
                <FlexRender content={header.column.columnDef.header} context={header.getContext()} />
              {/if}
            </Table.Head>
          {/each}
        </Table.Row>
      {/each}
    </Table.Header>
    <Table.Body>
      {#each table.getRowModel().rows as row (row.id)}
        <Table.Row data-state={row.getIsSelected() && "selected"}>
          {#each row.getVisibleCells() as cell (cell.id)}
            <Table.Cell>
              <FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
            </Table.Cell>
          {/each}
        </Table.Row>
      {:else}
        <Table.Row>
          <Table.Cell colspan={columns.length} class="h-24 text-center">No results.</Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
</div>
