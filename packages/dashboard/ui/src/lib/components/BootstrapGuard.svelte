<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import { goto } from "$app/navigation"
  import { page } from "$app/state"
  import { isLoggedIn } from "$lib/auth.js"
  import { run, dashboardApi } from "$lib/dashboard-api.js"
  import type { Snippet } from "svelte"
  import { resolve } from "$app/paths"

  const { children }: { children: Snippet } = $props()

  const publicPaths = [resolve(`/login`), resolve(`/register`)]
  const isPublic = $derived(publicPaths.some((p) => page.url.pathname === p || page.url.pathname.startsWith(p + "?")))
  const getIsPublic = () => isPublic

  const bootstrapQuery = createQuery(() => ({
    queryKey: ["bootstrap-status"],
    queryFn: () => run(dashboardApi.bootstrapStatus()),
    enabled: getIsPublic() && !isLoggedIn()
  }))

  $effect(() => {
    const data = bootstrapQuery.data
    if (!data && bootstrapQuery.isSuccess) {
      goto(data.bootstrapped ? resolve(`/login`) : resolve(`/register?${page.url.searchParams.toString()}`))
    }
  })
</script>

{@render children()}
