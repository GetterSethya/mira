<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query"
  import { mira } from "$lib/mira.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import * as InputGroup from "$lib/components/ui/input-group/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import * as Card from "$lib/components/ui/card/index.js"
  import { Spinner } from "$lib/components/ui/spinner"
  import { toast } from "svelte-sonner"
  import { clearLoggedIn } from "$lib/auth.js"
  import { goto } from "$app/navigation"
  import { base, resolve } from "$app/paths"
  import { IconLock, IconLockCheck, IconMail, IconUser } from "@tabler/icons-svelte"

  const queryClient = useQueryClient()

  const meQuery = createQuery(() => ({
    queryKey: ["_superadmin", "me"],
    queryFn: () => mira.superadmin.me().raw()
  }))

  let name = $state("")
  let email = $state("")
  let password = $state("")
  let passwordConfirm = $state("")

  /** Id the form was seeded from, so a refetch never clobbers in-flight edits. */
  let seededFor = $state<string | null>(null)

  $effect(() => {
    const me = meQuery.data
    if (!me || seededFor === me.id) return
    name = me.name ?? ""
    email = me.email ?? ""
    seededFor = me.id
  })

  let saving = $state(false)

  const passwordError = $derived(password.length > 0 && password !== passwordConfirm)
  const canSave = $derived(!saving && email.trim().length > 0 && !passwordError)

  async function save() {
    const me = meQuery.data
    if (!me || !canSave) return
    const passwordChanging = password.length > 0
    saving = true
    try {
      await mira.superadmin.update().raw({
        id: me.id,
        data: {
          name,
          email,
          ...(passwordChanging ? { password, passwordConfirm } : {})
        }
      })
      password = ""
      passwordConfirm = ""
      if (passwordChanging) {
        // The session token embeds a fingerprint of the stored password hash, so
        // changing the password invalidates the current session — sign out and
        // send the user to the login screen instead of leaving a dead page.
        mira.auth.clear()
        clearLoggedIn()
        toast.success("Password updated. Please sign in again.")
        goto(resolve("/login"))
        return
      }
      await queryClient.invalidateQueries({ queryKey: ["_superadmin"] })
      toast.success("Account updated")
    } catch {
      toast.error("Failed to update account")
    } finally {
      saving = false
    }
  }
</script>

<div class="space-y-6 max-w-2xl">
  <div>
    <a href="{base}/settings" class="text-sm text-muted-foreground hover:underline">← Settings</a>
    <h1 class="text-2xl font-bold mt-1">Account</h1>
  </div>

  {#if meQuery.isLoading}
    <p class="text-muted-foreground">Loading…</p>
  {:else if meQuery.isError || !meQuery.data}
    <p class="text-muted-foreground">Could not load your account.</p>
  {:else}
    <Card.Root>
      <Card.Header>
        <Card.Title class="text-sm">Profile</Card.Title>
        <Card.Description>Your superadmin name and email address.</Card.Description>
      </Card.Header>
      <Card.Content>
        <div class="flex flex-col gap-4">
          <Field.Field>
            <Field.Label>Name</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconUser />
              </InputGroup.Addon>
              <InputGroup.Input id="account-name" bind:value={name} autocomplete="name" />
            </InputGroup.Root>
          </Field.Field>
          <Field.Field>
            <Field.Label>Email</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconMail />
              </InputGroup.Addon>
              <InputGroup.Input
                id="account-email"
                type="email"
                bind:value={email}
                autocomplete="email"
              />
            </InputGroup.Root>
          </Field.Field>
        </div>
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title class="text-sm">Change password</Card.Title>
        <Card.Description>Leave blank to keep your current password.</Card.Description>
      </Card.Header>
      <Card.Content>
        <div class="flex flex-col gap-4">
          <Field.Field>
            <Field.Label>New password</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconLock />
              </InputGroup.Addon>
              <InputGroup.Input
                id="account-password"
                type="password"
                bind:value={password}
                autocomplete="new-password"
              />
            </InputGroup.Root>
          </Field.Field>
          <Field.Field data-invalid={passwordError}>
            <Field.Label>Confirm password</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconLockCheck />
              </InputGroup.Addon>
              <InputGroup.Input
                id="account-password-confirm"
                type="password"
                bind:value={passwordConfirm}
                autocomplete="new-password"
                aria-invalid={passwordError}
              />
            </InputGroup.Root>
            {#if passwordError}
              <Field.Error>Passwords do not match.</Field.Error>
            {/if}
          </Field.Field>
        </div>
      </Card.Content>
    </Card.Root>

    <div class="flex justify-end">
      <Button onclick={save} disabled={!canSave}>
        {#if saving}
          <Spinner />
        {/if}
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </div>
  {/if}
</div>
