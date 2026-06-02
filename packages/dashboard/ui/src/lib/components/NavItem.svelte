<script lang="ts">
  import { page } from "$app/stores"
  import { base } from "$app/paths"
  import { cn } from "$lib/utils.js"

  const { href, label, icon }: { href: string; label: string; icon?: string } = $props()
  const active = $derived($page.url.pathname === href || $page.url.pathname.startsWith(href + "/"))
</script>

<a
  href="{base}{href}"
  class={cn(
    "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
    active
      ? "bg-primary text-primary-foreground"
      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
  )}
>
  {#if icon}<span>{icon}</span>{/if}
  {label}
</a>
