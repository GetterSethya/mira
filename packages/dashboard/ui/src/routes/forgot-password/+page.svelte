<script lang="ts">
  import * as Field from "$lib/components/ui/field"
  import { Schema } from "effect"
  import { createAppForm } from "$lib/form.js"
  import { ForgotPasswordSchema, formatFieldErrors } from "$lib/validators.js"
  import { mira } from "$lib/mira.js"
  import * as Card from "$lib/components/ui/card/index.js"
  import { Input } from "$lib/components/ui/input/index.js"
  import { toast } from "svelte-sonner"
  import { createMutation } from "@tanstack/svelte-query"
  import { Button } from "$lib/components/ui/button"
  import { Spinner } from "$lib/components/ui/spinner"
  import { resolve } from "$app/paths"

  let submitted = $state(false)
  let error = $state("")

  const requestMutation = createMutation(() => ({
    mutationFn: async (address: string) => {
      await mira.superadmin.requestPasswordReset().raw({ email: address })
    },

    onSuccess: () => {
      submitted = true
      error = ""
      toast.success("If that email has an account, a reset link is on its way")
    },

    onError: () => {
      error = "Could not send the reset email. Please try again."
      toast.error("Password reset request failed")
    }
  }))

  const form = createAppForm(() => ({
    defaultValues: { email: "" },
    validators: { onChange: Schema.toStandardSchemaV1(ForgotPasswordSchema) },
    onSubmit: async ({ value }) => {
      error = ""
      await requestMutation.mutateAsync(value.email)
    }
  }))
</script>

<div class="min-h-screen flex items-center justify-center bg-background p-4">
  <Card.Root class="w-full max-w-sm">
    <Card.Header>
      <h1 class="text-2xl font-semibold tracking-tight">Forgot password</h1>
      <Card.Description>
        {#if submitted}
          Check your inbox for a password reset link.
        {:else}
          Enter your superadmin email and we will send you a reset link.
        {/if}
      </Card.Description>
    </Card.Header>
    <Card.Content>
      {#if submitted}
        <p class="text-sm text-muted-foreground">
          If an account exists for that email address, a password reset link has been sent. The
          link expires soon, so use it right away.
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
          <form.Field name="email">
            {#snippet children(field)}
              <Field.Field>
                <Field.Label for="forgot-email">Email</Field.Label>
                <Input
                  id="forgot-email"
                  type="email"
                  autocomplete="email"
                  required
                  class="h-11"
                  value={field.state.value}
                  oninput={(e) => field.handleChange(e.currentTarget.value)}
                  placeholder="admin@example.com"
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
            Send reset link
          </Button>
        </form>
      {/if}

      <a
        href={resolve(`/login`)}
        class="mt-4 block text-center text-sm text-primary hover:underline"
      >
        Back to sign in
      </a>
    </Card.Content>
  </Card.Root>
</div>
