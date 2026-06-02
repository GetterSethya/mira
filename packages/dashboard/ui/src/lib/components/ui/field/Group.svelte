<script lang="ts">
  import type { Snippet } from "svelte"
  const { children, orientation = "vertical" }: { children: Snippet; orientation?: string } = $props()
</script>

<div class={orientation === "horizontal" ? "flex flex-row items-center gap-3" : "flex flex-col gap-4"}>
  {@render children()}
</div>
