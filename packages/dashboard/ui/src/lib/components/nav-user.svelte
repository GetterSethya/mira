<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import * as Avatar from "$lib/components/ui/avatar"
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js"
  import { mira, SuperAdminCollection } from "$lib/mira.js"
  import { clearLoggedIn } from "$lib/auth.js"
  import { goto } from "$app/navigation"
  import { resolve } from "$app/paths"
  import { IconDotsVertical, IconLogout, IconUser } from "@tabler/icons-svelte"
  import { IconSize } from "$lib/constants"

  const meQuery = createQuery(() => ({
    queryKey: ["me"],
    queryFn: () => mira.me(SuperAdminCollection).raw()
  }))

  function logout() {
    mira.auth.clear()
    clearLoggedIn()
    goto(resolve(`/login`))
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Avatar.Root>
          <Avatar.Image src="" alt={meQuery.data?.record.name ?? ""} />
          <Avatar.Fallback>{meQuery.data?.record.name?.substring(0, 2) ?? ""}</Avatar.Fallback>
        </Avatar.Root>
        <div class="flex flex-col text-left">
          <span class="truncate text-md font-bold">{meQuery.data?.record.name || ""}</span>
          <span class="truncate text-sm text-foreground/70">{meQuery.data?.record.email || ""}</span>
        </div>
        <IconDotsVertical size={IconSize} />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="top" align="start">
    <DropdownMenu.Item>
      {#snippet child({ props })}
        <div
          {...props}
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Avatar.Root>
            <Avatar.Image src="" alt={meQuery.data?.record.name ?? ""} />
            <Avatar.Fallback>{meQuery.data?.record.name?.substring(0, 2) ?? ""}</Avatar.Fallback>
          </Avatar.Root>
          <div class="flex flex-col text-left">
            <span class="truncate text-md font-bold">{meQuery.data?.record.name || ""}</span>
            <span class="truncate text-sm text-foreground/70">{meQuery.data?.record.email || ""}</span>
          </div>
        </div>
      {/snippet}
    </DropdownMenu.Item>
    <DropdownMenu.Separator />

    <DropdownMenu.Item onclick={logout} class="cursor-pointer">
      <IconUser />
      <span class="leading-none">Account</span>
    </DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Item onclick={logout} class="cursor-pointer">
      <IconLogout class="text-destructive" />
      <span class="leading-none">Log out</span>
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
