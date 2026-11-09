<script lang="ts">
  import type { Snippet } from "svelte"

  const { children, ...rest }: { children: Snippet; [key: string]: unknown } = $props()
</script>

<p class="text-sm text-muted-foreground" {...rest}>{@render children()}</p>
