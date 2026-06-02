<script lang="ts">
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { isLoggedIn, clearToken } from "$lib/auth.js"
  import NavItem from "$lib/components/NavItem.svelte"
  import ThemeToggle from "$lib/components/ThemeToggle.svelte"
  import { Button } from "$lib/components/ui/button/index.js"
  import type { Snippet } from "svelte"

  const { children }: { children: Snippet } = $props()

  $effect(() => {
    if (!isLoggedIn()) goto(`${base}/login`)
  })

  function logout() {
    clearToken()
    goto(`${base}/login`)
  }
</script>

<div class="flex h-screen overflow-hidden bg-background">
  <aside class="w-56 shrink-0 border-r flex flex-col bg-sidebar text-sidebar-foreground">
    <div class="px-4 py-3 border-b font-semibold text-sm tracking-wide">Mira Dashboard</div>
    <nav class="flex flex-col gap-1 p-2 flex-1 overflow-y-auto">
      <NavItem href="/" label="Overview" icon="▦" />
      <NavItem href="/collections" label="Collections" icon="⊞" />
      <NavItem href="/logs" label="Logs" icon="≡" />
      <NavItem href="/spans" label="Spans" icon="⏳" />
      <NavItem href="/config" label="Config" icon="⚙" />
      <NavItem href="/settings" label="Settings" icon="◈" />
    </nav>
    <div class="p-2 border-t flex items-center gap-2">
      <ThemeToggle />
      <Button variant="ghost" size="sm" onclick={logout} class="flex-1 text-xs">Sign out</Button>
    </div>
  </aside>

  <main class="flex-1 overflow-y-auto p-6">
    {@render children()}
  </main>
</div>
