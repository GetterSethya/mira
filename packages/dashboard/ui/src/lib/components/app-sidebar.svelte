<script lang="ts" module>
</script>

<script lang="ts">
  import * as Collapsible from "$lib/components/ui/collapsible/index.js"
  import * as Sidebar from "$lib/components/ui/sidebar/index.js"
  import ChevronRight from "@tabler/icons-svelte/icons/chevron-right"
  import type { ComponentProps } from "svelte"
  import { resolve } from "$app/paths"
  import { createQuery } from "@tanstack/svelte-query"
  import { mira } from "$lib/mira.js"
  import NavUser from "$lib/components/nav-user.svelte"
  import { page } from "$app/state"
  import { IconServer, IconStack2, IconX } from "@tabler/icons-svelte"
  import { useSidebar } from "$lib/components/ui/sidebar/context.svelte.js"

  let { ref = $bindable(null), ...restProps }: ComponentProps<typeof Sidebar.Root> = $props()

  const sidebar = useSidebar()
  const schemaQuery = createQuery(() => ({ queryKey: ["schema"], queryFn: () => mira.telemetry.getSchema().raw() }))

  const collections = $derived(
    schemaQuery.isSuccess
      ? schemaQuery.data
          .filter((schema) => !schema.name.startsWith("_"))
          .map((schema) => ({
            title: schema.name,
            url: resolve(`/collections/${schema.name}`)
          }))
      : []
  )

  const systemCollections = $derived(
    schemaQuery.isSuccess
      ? schemaQuery.data
          .filter((schema) => schema.name.startsWith("_"))
          .map((schema) => ({
            title: schema.name,
            url: resolve(`/collections/${schema.name}`)
          }))
      : []
  )

  const data = $derived({
    navItem: [
      {
        title: "Collections",
        url: "/collections",
        items: collections,
        icon: IconStack2
      },
      {
        title: "System",
        url: "/collections",
        items: [
          ...systemCollections,
          {
            title: "logs",
            url: resolve("/logs")
          },
          {
            title: "spans",
            url: resolve("/spans")
          },
          {
            title: "cron",
            url: resolve("/crons")
          },
          {
            title: "settings",
            url: resolve("/settings")
          }
        ],
        icon: IconServer
      }
    ]
  })
</script>

<Sidebar.Root bind:ref {...restProps}>
  <Sidebar.Header class="flex flex-row items-center gap-1">
    <Sidebar.Menu class="min-w-0 flex-1">
      <Sidebar.MenuItem>
        <Sidebar.MenuButton class="data-[slot=sidebar-menu-button]:!p-1.5">
          {#snippet child({ props })}
            <a href={resolve("/")} {...props}>
              <span class="flex min-w-0 items-baseline gap-2">
                <span class="text-base font-semibold tracking-tight">mira</span>
                <span class="text-muted-foreground text-[0.6875rem] font-medium uppercase tracking-[0.18em]">admin</span>
              </span>
            </a>
          {/snippet}
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
    {#if sidebar.isMobile}
      <button
        type="button"
        class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground inline-flex size-11 shrink-0 items-center justify-center rounded-md"
        aria-label="Close navigation"
        onclick={() => sidebar.setOpenMobile(false)}
      >
        <IconX class="size-5" />
      </button>
    {/if}
  </Sidebar.Header>
  <Sidebar.Content class="gap-0">
    <!-- We create a collapsible SidebarGroup for each parent. -->
    {#each data.navItem as item (item.title)}
      {@const Icon = item.icon}
      <Collapsible.Root title={item.title} open class="group/collapsible">
        <Sidebar.Group>
          <Sidebar.GroupLabel
            class="group/label text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground text-sm"
          >
            {#snippet child({ props })}
              <Collapsible.Trigger {...props}>
                <Icon class="me-2" />
                {item.title}
                <ChevronRight class="ms-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
              </Collapsible.Trigger>
            {/snippet}
          </Sidebar.GroupLabel>
          <Collapsible.Content>
            <Sidebar.GroupContent>
              <Sidebar.Menu>
                {#each item.items as subItem (subItem.title)}
                  <Sidebar.MenuItem>
                    <Sidebar.MenuButton isActive={page.url.pathname === subItem.url}>
                      {#snippet child({ props })}
                        <a
                          href={subItem.url}
                          {...props}
                          aria-current={page.url.pathname === subItem.url ? "page" : undefined}
                        >{subItem.title}</a>
                      {/snippet}
                    </Sidebar.MenuButton>
                  </Sidebar.MenuItem>
                {/each}
              </Sidebar.Menu>
            </Sidebar.GroupContent>
          </Collapsible.Content>
        </Sidebar.Group>
      </Collapsible.Root>
    {/each}
  </Sidebar.Content>
  <Sidebar.Footer class="p-2">
    <NavUser />
  </Sidebar.Footer>
  <Sidebar.Rail />
</Sidebar.Root>
