<script lang="ts">
  import * as Field from "$lib/components/ui/field"
  import { Schema } from "effect"
  import { createAppForm } from "$lib/form.js"
  import { LoginSchema, formatFieldErrors } from "$lib/validators.js"
  import { mira } from "$lib/mira.js"
  import { setLoggedIn } from "$lib/auth.js"
  import { goto } from "$app/navigation"
  import * as Card from "$lib/components/ui/card/index.js"
  import { Input } from "$lib/components/ui/input/index.js"
  import { toast } from "svelte-sonner"
  import { createMutation } from "@tanstack/svelte-query"
  import { Button } from "$lib/components/ui/button"
  import { Spinner } from "$lib/components/ui/spinner"
  import { resolve } from "$app/paths"

  let error = $state("")

  type LoginMutationArgs = {
    email: string
    password: string
  }

  const loginMutation = createMutation(() => ({
    mutationFn: async (args: LoginMutationArgs) => {
      await mira.superadmin.authWithPassword().raw({ email: args.email, password: args.password })
      setLoggedIn()
    },

    onSuccess: () => {
      toast.success("Login success")
      goto(resolve(`/`))
    },

    onError: () => {
      toast.error("Login failed")
    }
  }))

  const form = createAppForm(() => ({
    defaultValues: { email: "", password: "" },
    validators: { onChange: Schema.standardSchemaV1(LoginSchema) },
    onSubmit: async ({ value }) => {
      return await loginMutation.mutateAsync(value)
    }
  }))
</script>

<div class="min-h-screen flex items-center justify-center bg-background p-4">
  <Card.Root class="w-full max-w-sm">
    <Card.Header>
      <Card.Title>Mira Dashboard</Card.Title>
      <Card.Description>Sign in to your superadmin account</Card.Description>
    </Card.Header>
    <Card.Content>
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
              <Field.Label>Email</Field.Label>
              <Input
                type="email"
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

        <form.Field name="password">
          {#snippet children(field)}
            <Field.Field>
              <Field.Label>Password</Field.Label>
              <Input
                type="password"
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

        <Button type="submit" disabled={form.state.isSubmitting}>
          {#if form.state.isSubmitting}
            <Spinner />
          {/if}
          Sign in
        </Button>
      </form>
    </Card.Content>
  </Card.Root>
</div>
