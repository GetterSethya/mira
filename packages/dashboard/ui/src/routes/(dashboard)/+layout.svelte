<script lang="ts">
  import { goto } from "$app/navigation"
  import { base, resolve } from "$app/paths"
  import { page } from "$app/state"
  import { isLoggedIn } from "$lib/auth.js"
  import AppSidebar from "$lib/components/app-sidebar.svelte"
  import ThemeToggle from "$lib/components/ThemeToggle.svelte"
  import * as Breadcrumb from "$lib/components/ui/breadcrumb/index.js"
  import * as Sidebar from "$lib/components/ui/sidebar/index.js"
  import type { Snippet } from "svelte"

  const { children }: { children: Snippet } = $props()

  $effect(() => {
    if (!isLoggedIn()) goto(resolve(`/login`))
  })

  const path = $derived(page.url.pathname.startsWith(base) ? page.url.pathname.slice(base.length) || "/" : page.url.pathname)
  const segments = $derived(path.split("/").filter(Boolean))

  function labelFor(segment: string): string {
    if (segment === "collections") return "Collections"
    if (segment === "settings") return "Settings"
    if (segment === "logs") return "Logs"
    if (segment === "spans") return "Spans"
    if (segment === "crons") return "Cron"
    return segment
  }

  const crumbs = $derived(
    segments.length === 0
      ? [{ label: "Overview", href: `${base}/` }]
      : segments.map((segment, index) => ({
          label: labelFor(segment),
          href: `${base}/${segments.slice(0, index + 1).join("/")}`
        }))
  )
</script>

<Sidebar.Provider>
  <AppSidebar />
  <Sidebar.Inset class="min-w-0">
    <header
      class="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-40 flex h-16 shrink-0 items-center gap-3 border-b px-4 backdrop-blur md:px-6"
    >
      <Sidebar.Trigger class="-ms-1 size-11 xl:size-9" />
      <Breadcrumb.Root class="min-w-0">
        <Breadcrumb.List class="min-w-0 flex-nowrap items-center text-[0.8125rem] leading-none">
          {#each crumbs as crumb, index (crumb.href)}
            {#if index > 0}
              <Breadcrumb.Separator class="flex items-center" />
            {/if}
            <Breadcrumb.Item class="min-w-0 leading-none">
              {#if index === crumbs.length - 1}
                <Breadcrumb.Page class="truncate font-mono text-[0.8125rem] leading-none">{crumb.label}</Breadcrumb.Page>
              {:else}
                <Breadcrumb.Link href={crumb.href} class="truncate text-[0.8125rem] leading-none">{crumb.label}</Breadcrumb.Link>
              {/if}
            </Breadcrumb.Item>
          {/each}
        </Breadcrumb.List>
      </Breadcrumb.Root>
      <ThemeToggle class="ml-auto size-11 xl:size-9" />
    </header>
    <div class="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-6">
      {@render children()}
    </div>
  </Sidebar.Inset>
</Sidebar.Provider>
