<script lang="ts">
  import type { Snippet } from "svelte"

  const { children, ...rest }: { children: Snippet; [key: string]: unknown } = $props()
</script>

<p role="alert" class="text-sm text-destructive" {...rest}>{@render children()}</p>
