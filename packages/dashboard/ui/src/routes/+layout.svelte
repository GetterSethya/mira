<script lang="ts">
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query"
  import { Toaster } from "$lib/components/ui/sonner/index.js"
  import BootstrapGuard from "$lib/components/BootstrapGuard.svelte"
  import { ModeWatcher } from "mode-watcher"
  import "../app.css"

  const { children } = $props()

  const queryClient = new QueryClient()
</script>

<ModeWatcher />
<QueryClientProvider client={queryClient}>
  <BootstrapGuard>
    {@render children()}
  </BootstrapGuard>
  <Toaster richColors />
</QueryClientProvider>
