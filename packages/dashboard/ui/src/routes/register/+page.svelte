<script lang="ts">
  import { page } from "$app/stores"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { client } from "$lib/client.js"
  import { createAppForm } from "$lib/form.js"
  import * as Card from "$lib/components/ui/card/index.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import { Input } from "$lib/components/ui/input/index.js"
  import { toast } from "svelte-sonner"

  const token = $derived($page.url.searchParams.get("token") ?? "")
  let error = $state("")

  const form = createAppForm(() => ({
    defaultValues: { email: "", password: "", token },
    onSubmit: async ({ value }: { value: { email: string; password: string; token: string } }) => {
      error = ""
      try {
        await client.register(value.email, value.password, value.token)
        toast.success("Account created! Please sign in.")
        goto(`${base}/login`)
      } catch {
        error = "Registration failed. Check your token."
        toast.error("Registration failed")
      }
    },
  }))
</script>

<div class="min-h-screen flex items-center justify-center bg-background p-4">
  <Card.Root class="w-full max-w-sm">
    <Card.Header>
      <Card.Title>Create superadmin</Card.Title>
      <Card.Description>First-time setup — register the initial superadmin account</Card.Description>
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

            {#if !token}
              <form.AppField name="token">
                {#snippet children(field)}
                  <Field.Field>
                    <Field.Label>Registration token</Field.Label>
                    <Input
                      value={field.state.value}
                      oninput={(e) => field.handleChange((e.target as HTMLInputElement).value)}
                      placeholder="Paste token from server logs"
                    />
                  </Field.Field>
                {/snippet}
              </form.AppField>
            {/if}

            {#if error}
              <p class="text-sm text-destructive">{error}</p>
            {/if}

            <form.SubmitButton label="Create account" />
          </div>
        {/snippet}
      </form.AppForm>
    </Card.Content>
  </Card.Root>
</div>
