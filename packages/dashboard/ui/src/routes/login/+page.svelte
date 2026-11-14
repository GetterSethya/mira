<script lang="ts">
  import * as Field from "$lib/components/ui/field"
  import { Schema } from "effect"
  import { createAppForm } from "$lib/form.js"
  import { LoginOtpSchema, LoginSchema, formatFieldErrors } from "$lib/validators.js"
  import { mira } from "$lib/mira.js"
  import { setLoggedIn } from "$lib/auth.js"
  import { goto } from "$app/navigation"
  import * as Card from "$lib/components/ui/card/index.js"
  import { Input } from "$lib/components/ui/input/index.js"
  import { toast } from "svelte-sonner"
  import { createMutation, createQuery } from "@tanstack/svelte-query"
  import { Button } from "$lib/components/ui/button"
  import { Spinner } from "$lib/components/ui/spinner"
  import { resolve } from "$app/paths"
  import { tick } from "svelte"

  type OtpFlow = "login" | "passwordless"

  let error = $state("")
  let email = $state("")
  let challengeId = $state("")
  let otpFlow = $state<OtpFlow | null>(null)
  let otpInput: HTMLInputElement | undefined = $state(undefined)

  $effect(() => {
    if (otpFlow !== null) {
      void tick().then(() => otpInput?.focus())
    }
  })

  const authConfigQuery = createQuery(() => ({
    queryKey: ["superadmin-auth-config"],
    queryFn: () => mira.superadmin.authConfig().raw()
  }))

  const authConfig = $derived(authConfigQuery.data)
  const showPasswordless = $derived(
    authConfig?.emailConfigured === true && authConfig.email.passwordless === true
  )

  type LoginMutationArgs = {
    email: string
    password: string
  }

  const loginMutation = createMutation(() => ({
    mutationFn: async (args: LoginMutationArgs) => {
      const result = await mira.superadmin
        .authWithPassword()
        .raw({ email: args.email, password: args.password })

      if ("token" in result) {
        setLoggedIn()
        return { otpRequired: false as const }
      }

      return { otpRequired: true as const, challengeId: result.challengeId }
    },

    onSuccess: (result) => {
      if (!result.otpRequired) {
        toast.success("Login success")
        goto(resolve(`/`))
        return
      }

      challengeId = result.challengeId
      otpFlow = "login"
      error = ""
      toast.success("Enter the code we emailed you")
    },

    onError: () => {
      error = "Invalid email or password."
      toast.error("Login failed")
    }
  }))

  type OtpMutationArgs = {
    challengeId: string
    code: string
    flow: OtpFlow
  }

  const otpMutation = createMutation(() => ({
    mutationFn: async (args: OtpMutationArgs) => {
      const result =
        args.flow === "login"
          ? await mira.superadmin
              .verifyLoginOtp()
              .raw({ challengeId: args.challengeId, code: args.code })
          : await mira.superadmin
              .loginWithPasswordlessOtp()
              .raw({ challengeId: args.challengeId, code: args.code })

      if (result.token) setLoggedIn()
      return result
    },

    onSuccess: () => {
      toast.success("Login success")
      goto(resolve(`/`))
    },

    onError: () => {
      error = "That code is invalid or has expired."
      toast.error("Code verification failed")
    }
  }))

  const resendMutation = createMutation(() => ({
    mutationFn: async (id: string) => {
      return await mira.superadmin.resendLoginOtp().raw({ challengeId: id })
    },

    onSuccess: (next) => {
      challengeId = next.challengeId
      error = ""
      toast.success("A new code is on its way")
    },

    onError: () => {
      toast.error("Could not resend the code")
    }
  }))

  const passwordlessMutation = createMutation(() => ({
    mutationFn: async (address: string) => {
      return await mira.superadmin.requestPasswordlessLogin().raw({ email: address })
    },

    onSuccess: (result) => {
      challengeId = result.challengeId
      otpFlow = "passwordless"
      error = ""
      toast.success("Enter the code we emailed you")
    },

    onError: () => {
      error = "Could not send a sign-in code."
      toast.error("Could not send a sign-in code")
    }
  }))

  const form = createAppForm(() => ({
    defaultValues: { email: "", password: "" },
    validators: { onChange: Schema.toStandardSchemaV1(LoginSchema) },
    onSubmit: async ({ value }) => {
      email = value.email
      error = ""
      await loginMutation.mutateAsync(value)
    }
  }))

  const otpForm = createAppForm(() => ({
    defaultValues: { code: "" },
    validators: { onChange: Schema.toStandardSchemaV1(LoginOtpSchema) },
    onSubmit: async ({ value }) => {
      if (!otpFlow || !challengeId) {
        error = "Your sign-in session expired. Please start again."
        return
      }

      error = ""
      await otpMutation.mutateAsync({ challengeId, code: value.code, flow: otpFlow })
    }
  }))

  function resendCode() {
    if (!challengeId) return

    if (otpFlow === "login") {
      resendMutation.mutate(challengeId)
    } else if (otpFlow === "passwordless" && email) {
      passwordlessMutation.mutate(email)
    }
  }

  function backToPassword() {
    otpFlow = null
    challengeId = ""
    error = ""
    otpForm.reset()
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-background p-4">
  <Card.Root class="w-full max-w-sm">
    <Card.Header>
      <h1 class="text-2xl font-semibold tracking-tight">Mira Dashboard</h1>
      <Card.Description>
        {#if otpFlow}
          Enter the six-digit code sent to {email || "your email address"}
        {:else}
          Sign in to your superadmin account
        {/if}
      </Card.Description>
    </Card.Header>
    <Card.Content>
      {#if otpFlow}
        <form
          class="flex flex-col gap-4"
          onsubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            otpForm.handleSubmit(e)
          }}
        >
          <otpForm.Field name="code">
            {#snippet children(field)}
              <Field.Field>
                <Field.Label for="login-otp">Sign-in code</Field.Label>
                <Input
                  id="login-otp"
                  bind:this={otpInput}
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  maxlength={6}
                  required
                  class="h-11"
                  placeholder="123456"
                  value={field.state.value}
                  oninput={(e) => field.handleChange(e.currentTarget.value)}
                />
                {#if field.state.meta.errors.length > 0}
                  <Field.Error>{formatFieldErrors(field.state.meta.errors)}</Field.Error>
                {/if}
              </Field.Field>
            {/snippet}
          </otpForm.Field>

          {#if error}
            <p class="text-sm text-destructive">{error}</p>
          {/if}

          <Button type="submit" class="h-11" disabled={otpForm.state.isSubmitting}>
            {#if otpForm.state.isSubmitting}
              <Spinner />
            {/if}
            Verify code
          </Button>

          <Button
            type="button"
            variant="outline"
            class="h-11"
            disabled={resendMutation.isPending || passwordlessMutation.isPending}
            onclick={resendCode}
          >
            {#if resendMutation.isPending || passwordlessMutation.isPending}
              <Spinner />
            {/if}
            Resend code
          </Button>

          <Button type="button" variant="ghost" onclick={backToPassword}>Back to sign in</Button>
        </form>
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
                <Field.Label for="login-email">Email</Field.Label>
                <Input
                  id="login-email"
                  type="email"
                  autocomplete="username"
                  required
                  class="h-11"
                  value={field.state.value}
                  oninput={(e) => {
                    email = e.currentTarget.value
                    field.handleChange(e.currentTarget.value)
                  }}
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
                <Field.Label for="login-password">Password</Field.Label>
                <Input
                  id="login-password"
                  type="password"
                  autocomplete="current-password"
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
            Sign in
          </Button>

          {#if showPasswordless}
            <Button
              type="button"
              variant="outline"
              disabled={passwordlessMutation.isPending || email.length === 0}
              onclick={() => passwordlessMutation.mutate(email)}
            >
              {#if passwordlessMutation.isPending}
                <Spinner />
              {/if}
              Email me a sign-in code
            </Button>
          {/if}

          <a href={resolve(`/forgot-password`)} class="text-center text-sm text-primary hover:underline">
            Forgot password?
          </a>
        </form>
      {/if}
    </Card.Content>
  </Card.Root>
</div>
