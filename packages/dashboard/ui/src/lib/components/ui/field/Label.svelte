<script lang="ts">
  import type { Snippet } from "svelte"

  const {
    children,
    for: htmlFor,
    ...rest
  }: { children: Snippet; for?: string; [key: string]: unknown } = $props()
</script>

<label for={htmlFor} class="text-sm font-medium leading-none" {...rest}>
  {@render children()}
</label>
