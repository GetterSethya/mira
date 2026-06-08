<script lang="ts">
  import { goto } from "$app/navigation"
  import { resolve } from "$app/paths"
  import { isLoggedIn, clearToken } from "$lib/auth.js"
  import AppSidebar from "$lib/components/app-sidebar.svelte"
  import ThemeToggle from "$lib/components/ThemeToggle.svelte"
  import * as Breadcrumb from "$lib/components/ui/breadcrumb/index.js"
  import * as Sidebar from "$lib/components/ui/sidebar/index.js"
  import { breadcrumbStore } from "$lib/stores/breadcrumb.svelte"
  import type { Snippet } from "svelte"

  const { children }: { children: Snippet } = $props()

  $effect(() => {
    if (!isLoggedIn()) goto(resolve(`/login`))
  })

  // function logout() {
  //   clearToken()
  //   goto(resolve(`/login`))
  // }
</script>

<Sidebar.Provider>
  <AppSidebar />
  <Sidebar.Inset>
    <header class="bg-background sticky z-40 top-0 flex h-16 shrink-0 items-center gap-2 border-b px-4">
      <Sidebar.Trigger class="-ms-1" />
      <Breadcrumb.Root>
        <Breadcrumb.List>
          {#each breadcrumbStore.current as bc, i (`${bc.type}-${bc.label}`)}
            {#if i % 2 === 0}
              <Breadcrumb.Separator class="hidden md:block" />
            {/if}
            {#if bc.type === "link"}
              <Breadcrumb.Item class="hidden md:block">
                <Breadcrumb.Link href={bc.href}>{bc.label}</Breadcrumb.Link>
              </Breadcrumb.Item>
            {/if}
            {#if bc.type === "leaf"}
              <Breadcrumb.Item>
                <Breadcrumb.Page>{bc.label}</Breadcrumb.Page>
              </Breadcrumb.Item>
            {/if}
          {/each}
        </Breadcrumb.List>
      </Breadcrumb.Root>
      <ThemeToggle class="ml-auto" />
    </header>
    <div class="flex flex-1 flex-col gap-4 p-4">
      {@render children()}
    </div>
  </Sidebar.Inset>
</Sidebar.Provider>
