<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query"
  import { run, dashboardApi, DashboardApiError } from "$lib/dashboard-api.js"
  import { mira } from "$lib/mira.js"
  import * as Card from "$lib/components/ui/card/index.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import * as InputGroup from "$lib/components/ui/input-group/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import { Spinner } from "$lib/components/ui/spinner"
  import {
    IconClock,
    IconCopy,
    IconEye,
    IconEyeOff,
    IconKey,
    IconLetterT,
    IconMail,
    IconNumbers,
    IconWorld
  } from "@tabler/icons-svelte"
  import { toast } from "svelte-sonner"
  import { base } from "$app/paths"

  const queryClient = useQueryClient()

  const configQuery = createQuery(() => ({ queryKey: ["config"], queryFn: () => run(dashboardApi.config()) }))
  const meQuery = createQuery(() => ({
    queryKey: ["_superadmin", "me"],
    queryFn: () => mira.superadmin.me().raw()
  }))

  let form = $state<Record<string, string>>({
    app_name: "",
    application_url: "",
    port: "",
    log_retention_days: ""
  })
  let revealed = $state<Record<string, boolean>>({})
  let saving = $state(false)
  let testTo = $state("")
  let sendingTest = $state(false)

  /** Seed the form once; later refetches must not clobber in-flight edits. */
  let seeded = $state(false)
  $effect(() => {
    const data = configQuery.data
    if (!data || seeded) return
    const v = data.values
    form = Object.fromEntries(Object.entries(form).map(([key]) => [key, v[key] ?? ""]))
    seeded = true
  })

  const errors = $derived.by(() => {
    const out: Record<string, string> = {}
    if (!form["app_name"].trim()) out["app_name"] = "Required"
    if (!URL.canParse(form["application_url"])) out["application_url"] = "Must be a valid URL"
    const port = Number(form["port"])
    if (!Number.isInteger(port) || port < 0 || port > 65535) out["port"] = "Integer between 0 and 65535"
    const days = Number(form["log_retention_days"])
    if (!Number.isInteger(days) || days < 1) out["log_retention_days"] = "Must be at least 1"
    return out
  })
  const valid = $derived(Object.keys(errors).length === 0)

  const ownEmail = $derived(meQuery.data?.email ?? "")
  const testToValue = $derived(testTo.trim())
  const testToInvalid = $derived(testToValue.length > 0 && testToValue !== ownEmail)

  const isRevealed = (key: string) => revealed[key] === true
  function toggleReveal(key: string) {
    revealed = { ...revealed, [key]: !isRevealed(key) }
  }

  async function copy(key: string, value: string) {
    if (!value) return
    await navigator.clipboard.writeText(value)
    toast.success(`${key} copied`)
  }

  async function save() {
    if (!valid || saving) return
    saving = true
    try {
      const payload: Record<string, string> = {
        app_name: form["app_name"].trim(),
        application_url: form["application_url"].trim(),
        port: String(Number(form["port"])),
        log_retention_days: String(Number(form["log_retention_days"]))
      }
      await run(dashboardApi.updateConfig(payload))
      await queryClient.invalidateQueries({ queryKey: ["config"] })
      toast.success("Config saved — restart the server to apply")
    } catch {
      toast.error("Failed to save config")
    } finally {
      saving = false
    }
  }

  async function sendTestEmail() {
    if (sendingTest || testToInvalid) return
    sendingTest = true
    try {
      // The route only accepts the authenticated superadmin's own address.
      const target = testToValue.length > 0 ? testToValue : ownEmail
      await run(dashboardApi.emailTest(target.length > 0 ? target : undefined))
      toast.success("Test email sent")
    } catch (error) {
      if (error instanceof DashboardApiError) {
        if (error.status === 403) toast.error("You can only send a test email to your own address")
        else if (error.status === 429) {
          const seconds = error.retryAfterSeconds
          toast.error(
            seconds === undefined
              ? "Too many test emails — try again later"
              : `Too many test emails — try again in ${seconds}s`
          )
        }
        else if (error.status === 503) toast.error("Email is not configured on this server")
        else if (error.status === 502) toast.error("The email server could not deliver the message")
        else toast.error("Failed to send test email")
      } else {
        toast.error("Failed to send test email")
      }
    } finally {
      sendingTest = false
    }
  }

  function reset() {
    seeded = false
  }

  function tlsLabel(email: { secure: boolean; requireTLS: boolean }): string {
    if (email.secure) return email.requireTLS ? "Implicit TLS, STARTTLS required" : "Implicit TLS"
    return email.requireTLS ? "STARTTLS required" : "Opportunistic STARTTLS"
  }
</script>

<div class="space-y-6 max-w-2xl">
  <div>
    <a href="{base}/settings" class="text-sm text-muted-foreground hover:underline">← Settings</a>
    <h1 class="text-2xl font-bold mt-1">App</h1>
    <p class="text-sm text-muted-foreground mt-1">
      Server configuration, stored in the <code>_config</code> table. Changes take effect after a
      restart.
    </p>
  </div>

  {#if configQuery.isLoading}
    <p class="text-muted-foreground">Loading…</p>
  {:else if configQuery.isError || !configQuery.data}
    <p class="text-muted-foreground">Could not load the server config.</p>
  {:else}
    {@const data = configQuery.data}

    <Card.Root>
      <Card.Header>
        <Card.Title class="text-sm">Application</Card.Title>
        <Card.Description>Name, public URL, and the port the server binds to.</Card.Description>
      </Card.Header>
      <Card.Content>
        <div class="flex flex-col gap-4">
          <Field.Field data-invalid={errors["app_name"] ? true : undefined}>
            <Field.Label for="app-name">App name</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconLetterT />
              </InputGroup.Addon>
              <InputGroup.Input
                id="app-name"
                value={form["app_name"]}
                oninput={(e) => (form["app_name"] = e.currentTarget.value)}
                aria-invalid={errors["app_name"] ? true : undefined}
              />
            </InputGroup.Root>
            {#if errors["app_name"]}<Field.Error>{errors["app_name"]}</Field.Error>{/if}
          </Field.Field>

          <Field.Field data-invalid={errors["application_url"] ? true : undefined}>
            <Field.Label for="application-url">Application URL</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconWorld />
              </InputGroup.Addon>
              <InputGroup.Input
                id="application-url"
                value={form["application_url"]}
                oninput={(e) => (form["application_url"] = e.currentTarget.value)}
                placeholder="http://localhost:8080"
                aria-invalid={errors["application_url"] ? true : undefined}
              />
            </InputGroup.Root>
            {#if errors["application_url"]}
              <Field.Error>{errors["application_url"]}</Field.Error>
            {/if}
          </Field.Field>

          <Field.Field data-invalid={errors["port"] ? true : undefined}>
            <Field.Label for="app-port">Port</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconNumbers />
              </InputGroup.Addon>
              <InputGroup.Input
                id="app-port"
                type="number"
                value={form["port"]}
                oninput={(e) => (form["port"] = e.currentTarget.value)}
                aria-invalid={errors["port"] ? true : undefined}
              />
            </InputGroup.Root>
            {#if errors["port"]}<Field.Error>{errors["port"]}</Field.Error>{/if}
          </Field.Field>

          <div class="text-xs text-muted-foreground">
            Effective: <a class="underline" href={data.applicationUrl} target="_blank" rel="noreferrer"
              >{data.applicationUrl}</a
            > (port {data.port})
          </div>
        </div>
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title class="text-sm">JWT</Card.Title>
        <Card.Description>
          Session-token signing secret. Read-only — rotating it invalidates every existing session.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {@render SecretRow({
          label: "jwt_secret",
          value: data.values["jwt_secret"] ?? "",
          revealed: isRevealed("jwt_secret"),
          onToggle: () => toggleReveal("jwt_secret"),
          onCopy: () => copy("jwt_secret", data.values["jwt_secret"] ?? "")
        })}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title class="text-sm">Storage</Card.Title>
        <Card.Description>Live file-storage backend, resolved when the app starts.</Card.Description>
      </Card.Header>
      <Card.Content>
        <div class="flex flex-col gap-4">
          {#if data.storage === null}
            <p class="text-sm text-muted-foreground">Description unavailable.</p>
          {:else}
            <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt class="text-muted-foreground">Kind</dt>
              <dd>{data.storage.kind === "local" ? "Local directory" : "S3-compatible"}</dd>

              {#if data.storage.kind === "local"}
                <dt class="text-muted-foreground">Directory</dt>
                <dd class="font-mono break-all">{data.storage.directory}</dd>
              {:else}
                <dt class="text-muted-foreground">Endpoint</dt>
                <dd class="font-mono break-all">{data.storage.endpoint}</dd>
                <dt class="text-muted-foreground">Bucket</dt>
                <dd class="font-mono break-all">{data.storage.bucketName}</dd>
                <dt class="text-muted-foreground">Region</dt>
                <dd class="font-mono break-all">{data.storage.regionName}</dd>
                <dt class="text-muted-foreground">Path style</dt>
                <dd>{data.storage.forcePathStyle ? "Enabled" : "Disabled"}</dd>
                {#if data.storage.publicBaseUrl}
                  <dt class="text-muted-foreground">Public base URL</dt>
                  <dd class="font-mono break-all">{data.storage.publicBaseUrl}</dd>
                {/if}
              {/if}
            </dl>
          {/if}
          <p class="text-xs text-muted-foreground">
            Read-only. The live storage backend is selected in code with <code>.storage(...)</code>.
            Restart the app to change it.
          </p>
        </div>
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title class="text-sm">Email</Card.Title>
        <Card.Description>Live email transport, resolved when the app starts.</Card.Description>
      </Card.Header>
      <Card.Content>
        <div class="flex flex-col gap-4">
          <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt class="text-muted-foreground">Status</dt>
            <dd>{data.email.enabled ? "Enabled" : "Not configured"}</dd>
            <dt class="text-muted-foreground">Transport</dt>
            <dd>{data.email.transport === "smtp" ? "SMTP" : "None"}</dd>
            <dt class="text-muted-foreground">Host</dt>
            <dd class="font-mono break-all">{data.email.host ?? "—"}</dd>
            <dt class="text-muted-foreground">Port</dt>
            <dd class="font-mono">{data.email.port === null ? "—" : String(data.email.port)}</dd>
            <dt class="text-muted-foreground">TLS</dt>
            <dd>{tlsLabel(data.email)}</dd>
            <dt class="text-muted-foreground">From</dt>
            <dd class="font-mono break-all">{data.email.from ?? "—"}</dd>
            <dt class="text-muted-foreground">Reply-To</dt>
            <dd class="font-mono break-all">{data.email.replyTo ?? "—"}</dd>
            <dt class="text-muted-foreground">Authentication</dt>
            <dd>{data.email.hasAuth ? "Yes" : "No"}</dd>
            {#if data.email.passwordResetUrl}
              <dt class="text-muted-foreground">Password reset URL</dt>
              <dd class="font-mono break-all">{data.email.passwordResetUrl}</dd>
            {/if}
          </dl>

          <p class="text-xs text-muted-foreground">
            Read-only. The live email transport is selected in code with
            <code>.email(SmtpEmail(...))</code>. Credentials are never shown here.
          </p>
        </div>
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title class="text-sm">Email diagnostics</Card.Title>
        <Card.Description>
          Send a test message through the live transport to verify delivery.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <Field.Field data-invalid={testToInvalid ? true : undefined}>
          <Field.Label for="test-email-to">Send test email to</Field.Label>
          <div class="flex flex-col gap-2 sm:flex-row">
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconMail />
              </InputGroup.Addon>
              <InputGroup.Input
                id="test-email-to"
                type="email"
                bind:value={testTo}
                placeholder={ownEmail || "you@example.com"}
                autocomplete="email"
                class="h-11"
                aria-invalid={testToInvalid ? true : undefined}
              />
            </InputGroup.Root>
            <Button
              variant="outline"
              class="h-11"
              onclick={sendTestEmail}
              disabled={sendingTest || testToInvalid}
            >
              {#if sendingTest}<Spinner />{/if}
              {sendingTest ? "Sending…" : "Send test email"}
            </Button>
          </div>
          <Field.Description>
            Leave blank to send to your own superadmin address. Only your own address is
            accepted.
          </Field.Description>
          {#if testToInvalid}
            <Field.Error>Only your own address is accepted.</Field.Error>
          {/if}
        </Field.Field>
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title class="text-sm">Logs</Card.Title>
        <Card.Description>How long the log-cleanup cron keeps records.</Card.Description>
      </Card.Header>
      <Card.Content>
        <Field.Field data-invalid={errors["log_retention_days"] ? true : undefined}>
          <Field.Label for="log-retention-days">Retention (days)</Field.Label>
          <InputGroup.Root>
            <InputGroup.Addon>
              <IconClock />
            </InputGroup.Addon>
            <InputGroup.Input
              id="log-retention-days"
              type="number"
              value={form["log_retention_days"]}
              oninput={(e) => (form["log_retention_days"] = e.currentTarget.value)}
              aria-invalid={errors["log_retention_days"] ? true : undefined}
            />
          </InputGroup.Root>
          {#if errors["log_retention_days"]}<Field.Error>{errors["log_retention_days"]}</Field.Error>{/if}
        </Field.Field>
      </Card.Content>
    </Card.Root>

    <div
      class="sticky bottom-0 z-10 -mx-4 flex items-center justify-between gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur"
    >
      <p class="text-xs text-muted-foreground">Changes apply after a server restart.</p>
      <div class="flex items-center gap-2">
        <Button variant="outline" onclick={reset} disabled={saving}>Reset</Button>
        <Button onclick={save} disabled={!valid || saving}>
          {#if saving}<Spinner />{/if}
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  {/if}
</div>

{#snippet RevealButton({
  revealed,
  onToggle
}: {
  revealed: boolean
  onToggle: () => void
})}
  <InputGroup.Button
    size="icon-xs"
    aria-label={revealed ? "Hide value" : "Show value"}
    onclick={onToggle}
  >
    {#if revealed}<IconEyeOff />{:else}<IconEye />{/if}
  </InputGroup.Button>
{/snippet}

{#snippet SecretRow({
  label,
  value,
  revealed,
  onToggle,
  onCopy
}: {
  label: string
  value: string
  revealed: boolean
  onToggle: () => void
  onCopy: () => void
})}
  <Field.Field>
    <Field.Label for="jwt-secret">{label}</Field.Label>
    <InputGroup.Root>
      <InputGroup.Addon>
        <IconKey />
      </InputGroup.Addon>
      <InputGroup.Input
        id="jwt-secret"
        class="font-mono"
        type={revealed ? "text" : "password"}
        {value}
        readonly
      />
      <InputGroup.Addon align="inline-end">
        {@render RevealButton({ revealed, onToggle })}
        <InputGroup.Button size="icon-xs" aria-label="Copy value" onclick={onCopy}>
          <IconCopy />
        </InputGroup.Button>
      </InputGroup.Addon>
    </InputGroup.Root>
  </Field.Field>
{/snippet}
