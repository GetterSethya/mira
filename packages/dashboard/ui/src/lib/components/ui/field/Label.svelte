<script lang="ts">
  import type { Snippet } from "svelte"
  const { children }: { children: Snippet } = $props()
</script>

<label class="text-sm font-medium leading-none">
  {@render children()}
</label>
