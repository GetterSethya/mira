<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import { goto } from "$app/navigation"
  import { page } from "$app/state"
  import { base } from "$app/paths"
  import { isLoggedIn } from "$lib/auth.js"
  import { client } from "$lib/client.js"
  import type { Snippet } from "svelte"

  const { children }: { children: Snippet } = $props()

  const publicPaths = [`${base}/login`, `${base}/register`]
  const isPublic = $derived(publicPaths.some((p) => page.url.pathname === p || page.url.pathname.startsWith(p + "?")))
  const getIsPublic = () => isPublic

  const bootstrapQuery = createQuery(() => ({
    queryKey: ["bootstrap-status"],
    queryFn: () => client.bootstrapStatus(),
    enabled: getIsPublic() && !isLoggedIn()
  }))

  $effect(() => {
    const data = bootstrapQuery.data
    if (!data && bootstrapQuery.isSuccess) {
      goto(data.bootstrapped ? `${base}/login` : `${base}/register?${page.url.searchParams.toString()}`)
    }
  })
</script>

{@render children()}
