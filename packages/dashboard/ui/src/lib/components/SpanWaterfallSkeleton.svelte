<script lang="ts">
  import { Skeleton } from "$lib/components/ui/skeleton/index.js"

  const { rows = 6 }: { rows?: number } = $props()

  function widthFor(row: number, seed: number) {
    return `${50 + ((row * 7 + seed * 13) % 40)}%`
  }
</script>

<div class="flex flex-col gap-4">
  {#each { length: rows } as _, row (row)}
    <div class="rounded-md border">
      <div class="flex flex-col w-full gap-3 px-4 py-2">
        <div class="flex flex-1 items-center gap-3">
          <Skeleton class="size-8 rounded-md shrink-0" />
          <Skeleton class="h-4 w-32" />
          <Skeleton class="h-4 max-w-(--skeleton-width)" style="--skeleton-width: {widthFor(row, 1)};" />
          <Skeleton class="h-4 w-28 ml-auto shrink-0" />
        </div>
        <div class="flex gap-3">
          <Skeleton class="h-5 w-32 rounded-full" />
          <Skeleton class="h-5 w-24 rounded-full" />
          <Skeleton class="h-5 w-28 rounded-full" />
        </div>
      </div>
    </div>
  {/each}
</div>
