<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js"
  import { theme } from "$lib/theme.svelte.js"
</script>

<Button variant="ghost" size="icon" onclick={() => theme.toggle()} aria-label="Toggle theme">
  {#if theme.current === "dark"}
    🌙
  {:else}
    ☀️
  {/if}
</Button>
