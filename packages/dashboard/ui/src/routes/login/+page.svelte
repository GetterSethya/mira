<script lang="ts">
  import { createAppForm } from "$lib/form.js"
  import { client } from "$lib/client.js"
  import { setToken } from "$lib/auth.js"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import * as Card from "$lib/components/ui/card/index.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import { Input } from "$lib/components/ui/input/index.js"
  import { toast } from "svelte-sonner"

  let error = $state("")

  const form = createAppForm(() => ({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }: { value: { email: string; password: string } }) => {
      error = ""
      try {
        const res = await client.login(value.email, value.password)
        setToken(res.token)
        goto(`${base}/`)
      } catch {
        error = "Invalid email or password"
        toast.error("Login failed")
      }
    },
  }))
</script>

<div class="min-h-screen flex items-center justify-center bg-background p-4">
  <Card.Root class="w-full max-w-sm">
    <Card.Header>
      <Card.Title>Mira Dashboard</Card.Title>
      <Card.Description>Sign in to your superadmin account</Card.Description>
    </Card.Header>
    <Card.Content>
      <form.AppForm>
        {#snippet children()}
          <div class="flex flex-col gap-4">
            <form.AppField name="email">
              {#snippet children(field)}
                <Field.Field>
                  <Field.Label>Email</Field.Label>
                  <Input
                    type="email"
                    value={field.state.value}
                    oninput={(e) => field.handleChange((e.target as HTMLInputElement).value)}
                    placeholder="admin@example.com"
                  />
                </Field.Field>
              {/snippet}
            </form.AppField>

            <form.AppField name="password">
              {#snippet children(field)}
                <Field.Field>
                  <Field.Label>Password</Field.Label>
                  <Input
                    type="password"
                    value={field.state.value}
                    oninput={(e) => field.handleChange((e.target as HTMLInputElement).value)}
                  />
                </Field.Field>
              {/snippet}
            </form.AppField>

            {#if error}
              <p class="text-sm text-destructive">{error}</p>
            {/if}

            <form.SubmitButton label="Sign in" />
          </div>
        {/snippet}
      </form.AppForm>
    </Card.Content>
  </Card.Root>
</div>
