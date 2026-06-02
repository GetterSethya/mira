<script lang="ts">
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query"
  import { Toaster } from "$lib/components/ui/sonner/index.js"
  import BootstrapGuard from "$lib/components/BootstrapGuard.svelte"
  import "../app.css"
  import type { Snippet } from "svelte"

  const { children }: { children: Snippet } = $props()

  const queryClient = new QueryClient()
</script>

<QueryClientProvider client={queryClient}>
  <BootstrapGuard>
    {@render children()}
  </BootstrapGuard>
  <Toaster richColors />
</QueryClientProvider>
