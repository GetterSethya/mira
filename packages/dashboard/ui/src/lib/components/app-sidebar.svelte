<script lang="ts" module>
</script>

<script lang="ts">
  import * as Collapsible from "$lib/components/ui/collapsible/index.js"
  import * as Sidebar from "$lib/components/ui/sidebar/index.js"
  import ChevronRight from "@tabler/icons-svelte/icons/chevron-right"
  import type { ComponentProps } from "svelte"
  import Layout from "@tabler/icons-svelte/icons/layout"
  import { resolve } from "$app/paths"
  import { createQuery } from "@tanstack/svelte-query"
  import { mira } from "$lib/mira.js"
  import NavUser from "$lib/components/nav-user.svelte"
  import { page } from "$app/state"
  import { IconServer, IconStack2 } from "@tabler/icons-svelte"

  let { ref = $bindable(null), ...restProps }: ComponentProps<typeof Sidebar.Root> = $props()

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
          }
        ],
        icon: IconServer
      }
    ]
  })
</script>

<Sidebar.Root bind:ref {...restProps}>
  <Sidebar.Header>
    <Sidebar.Menu>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton class="data-[slot=sidebar-menu-button]:!p-1.5">
          {#snippet child({ props })}
            <a href={resolve("/")} {...props}>
              <Layout />
              <span class="text-base font-semibold">Mira Dashboard</span>
            </a>
          {/snippet}
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
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
                        <a href={subItem.url} {...props}>{subItem.title}</a>
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
