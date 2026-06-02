<script lang="ts">
  import type { Snippet } from "svelte"
  const { children }: { children: Snippet } = $props()
</script>

<p class="text-sm text-muted-foreground">{@render children()}</p>
