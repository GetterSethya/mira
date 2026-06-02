<script lang="ts">
  import type { Snippet } from "svelte"
  const { children, ...rest }: { children: Snippet; [k: string]: unknown } = $props()
</script>

<div class="flex flex-col gap-1.5" {...rest}>
  {@render children()}
</div>
