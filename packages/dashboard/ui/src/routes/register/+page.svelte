<script lang="ts">
  import * as Field from "$lib/components/ui/field"
  import { Schema } from "effect"
  import { page } from "$app/state"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { client } from "$lib/client.js"
  import { createAppForm } from "$lib/form.js"
  import { RegisterSchema, formatFieldErrors } from "$lib/validators.js"
  import * as Card from "$lib/components/ui/card/index.js"
  import { Input } from "$lib/components/ui/input/index.js"
  import { toast } from "svelte-sonner"
  import { createMutation } from "@tanstack/svelte-query"
  import { Button } from "$lib/components/ui/button"
  import { Spinner } from "$lib/components/ui/spinner"

  const token = $derived(page.url.searchParams.get("token") ?? "")
  let error = $state("")

  type RegisterMutationArgs = {
    email: string
    password: string
    token: string
  }

  const registerMutation = createMutation(() => ({
    mutationFn: async (args: RegisterMutationArgs) => {
      return await client.register(args.email, args.password, args.token)
    },
    onSuccess: () => {
      toast.success("Account created! Please sign in.")
      goto(`${base}/login`)
    },
    onError: () => {
      toast.error("Registration failed")
    }
  }))

  const form = createAppForm(() => ({
    defaultValues: { email: "", password: "" },
    validators: { onChange: Schema.standardSchemaV1(RegisterSchema) },
    onSubmit: async ({ value }) => {
      return await registerMutation.mutateAsync({ ...value, token })
    }
  }))
</script>

<div class="min-h-screen flex items-center justify-center bg-background p-4">
  <Card.Root class="w-full max-w-sm">
    <Card.Header>
      <Card.Title>Create superadmin</Card.Title>
      <Card.Description>First-time setup — register the initial superadmin account</Card.Description>
    </Card.Header>
    <Card.Content>
      <form
        onsubmit={(e) => {
          e.preventDefault()
          e.stopPropagation()
          form.handleSubmit(e)
        }}
        class="flex flex-col gap-4"
      >
        <form.Field name="email">
          {#snippet children(field)}
            <Field.Field>
              <Field.Label>Email</Field.Label>
              <Input
                type="email"
                value={field.state.value}
                oninput={(e) => field.handleChange(e.currentTarget.value)}
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
          Create account</Button
        >
      </form>
    </Card.Content>
  </Card.Root>
</div>
