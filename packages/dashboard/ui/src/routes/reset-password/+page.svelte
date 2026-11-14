<script lang="ts">
  import * as Field from "$lib/components/ui/field"
  import { Schema } from "effect"
  import { page } from "$app/state"
  import { goto } from "$app/navigation"
  import { createAppForm } from "$lib/form.js"
  import { ResetPasswordSchema, formatFieldErrors } from "$lib/validators.js"
  import { mira } from "$lib/mira.js"
  import * as Card from "$lib/components/ui/card/index.js"
  import { Input } from "$lib/components/ui/input/index.js"
  import { toast } from "svelte-sonner"
  import { createMutation } from "@tanstack/svelte-query"
  import { Button } from "$lib/components/ui/button"
  import { Spinner } from "$lib/components/ui/spinner"
  import { resolve } from "$app/paths"

  const token = $derived(page.url.searchParams.get("token") ?? "")
  const collection = $derived(page.url.searchParams.get("collection") ?? "")
  const isSuperadminReset = $derived(collection === "_superadmin")
  const canReset = $derived(isSuperadminReset && token.length > 0)

  let error = $state("")

  type ResetMutationArgs = {
    password: string
    passwordConfirm: string
  }

  const resetMutation = createMutation(() => ({
    mutationFn: async (args: ResetMutationArgs) => {
      await mira.superadmin.resetPassword().raw({
        token,
        password: args.password,
        passwordConfirm: args.passwordConfirm
      })
    },

    onSuccess: () => {
      toast.success("Password updated. Please sign in.")
      goto(resolve(`/login`))
    },

    onError: () => {
      error = "This reset link is invalid or has expired. Request a new one."
      toast.error("Password reset failed")
    }
  }))

  const form = createAppForm(() => ({
    defaultValues: { password: "", passwordConfirm: "" },
    validators: { onChange: Schema.toStandardSchemaV1(ResetPasswordSchema) },
    onSubmit: async ({ value }) => {
      if (value.password !== value.passwordConfirm) {
        error = "Passwords do not match."
        return
      }

      error = ""
      await resetMutation.mutateAsync(value)
    }
  }))
</script>

<div class="min-h-screen flex items-center justify-center bg-background p-4">
  <Card.Root class="w-full max-w-sm">
    <Card.Header>
      <h1 class="text-2xl font-semibold tracking-tight">Reset password</h1>
      <Card.Description>
        {#if !isSuperadminReset}
          This reset link is not valid for the dashboard.
        {:else if !canReset}
          This reset link is missing its token.
        {:else}
          Choose a new password for your superadmin account.
        {/if}
      </Card.Description>
    </Card.Header>
    <Card.Content>
      {#if !canReset}
        <p class="text-sm text-destructive">
          {#if !isSuperadminReset}
            This link was issued for a different account collection. Request a new reset link from
            the dashboard sign-in page.
          {:else}
            The reset token is missing from this link. Request a new reset email from the dashboard
            sign-in page.
          {/if}
        </p>
      {:else}
        <form
          class="flex flex-col gap-4"
          onsubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            form.handleSubmit(e)
          }}
        >
          <form.Field name="password">
            {#snippet children(field)}
              <Field.Field>
                <Field.Label for="reset-password">New password</Field.Label>
                <Input
                  id="reset-password"
                  type="password"
                  autocomplete="new-password"
                  required
                  class="h-11"
                  value={field.state.value}
                  oninput={(e) => field.handleChange(e.currentTarget.value)}
                />
                {#if field.state.meta.errors.length > 0}
                  <Field.Error>{formatFieldErrors(field.state.meta.errors)}</Field.Error>
                {/if}
              </Field.Field>
            {/snippet}
          </form.Field>

          <form.Field name="passwordConfirm">
            {#snippet children(field)}
              <Field.Field>
                <Field.Label for="reset-password-confirm">Confirm new password</Field.Label>
                <Input
                  id="reset-password-confirm"
                  type="password"
                  autocomplete="new-password"
                  required
                  class="h-11"
                  value={field.state.value}
                  oninput={(e) => field.handleChange(e.currentTarget.value)}
                />
                {#if field.state.meta.errors.length > 0}
                  <Field.Error>{formatFieldErrors(field.state.meta.errors)}</Field.Error>
                {/if}
              </Field.Field>
            {/snippet}
          </form.Field>

          {#if error}
            <p class="text-sm text-destructive">{error}</p>
          {/if}

          <Button type="submit" class="h-11" disabled={form.state.isSubmitting}>
            {#if form.state.isSubmitting}
              <Spinner />
            {/if}
            Update password
          </Button>
        </form>
      {/if}

      <a href={resolve(`/login`)} class="mt-4 block text-center text-sm text-primary hover:underline">
        Back to sign in
      </a>
    </Card.Content>
  </Card.Root>
</div>
