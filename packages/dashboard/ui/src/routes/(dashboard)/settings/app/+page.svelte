<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query"
  import { run, dashboardApi } from "$lib/dashboard-api.js"
  import * as Card from "$lib/components/ui/card/index.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import * as InputGroup from "$lib/components/ui/input-group/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import { Switch } from "$lib/components/ui/switch/index.js"
  import { Spinner } from "$lib/components/ui/spinner"
  import {
    IconBucket,
    IconClock,
    IconCopy,
    IconEye,
    IconEyeOff,
    IconKey,
    IconLetterT,
    IconLock,
    IconMapPin,
    IconNumbers,
    IconWorld
  } from "@tabler/icons-svelte"
  import { toast } from "svelte-sonner"
  import { base } from "$app/paths"

  const queryClient = useQueryClient()

  const configQuery = createQuery(() => ({ queryKey: ["config"], queryFn: () => run(dashboardApi.config()) }))

  const S3_KEYS = ["s3_endpoint", "s3_bucket_name", "s3_region_name", "s3_access_key", "s3_secret"] as const

  let form = $state<Record<string, string>>({
    app_name: "",
    application_url: "",
    port: "",
    log_retention_days: "",
    s3_endpoint: "",
    s3_bucket_name: "",
    s3_region_name: "",
    s3_access_key: "",
    s3_secret: ""
  })
  let useS3 = $state(false)
  let revealed = $state<Record<string, boolean>>({})
  let saving = $state(false)

  /** Seed the form once; later refetches must not clobber in-flight edits. */
  let seeded = $state(false)
  $effect(() => {
    const data = configQuery.data
    if (!data || seeded) return
    const v = data.values
    form = Object.fromEntries(
      Object.entries(form).map(([key]) => [key, v[key] ?? ""])
    ) as Record<string, string>
    useS3 = v["use_s3"] === "true"
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
    if (useS3) {
      for (const key of S3_KEYS) {
        if (!form[key].trim()) out[key] = "Required when S3 is enabled"
      }
    }
    return out
  })
  const valid = $derived(Object.keys(errors).length === 0)

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
        log_retention_days: String(Number(form["log_retention_days"])),
        use_s3: useS3 ? "true" : "false"
      }
      for (const key of S3_KEYS) {
        const value = form[key].trim()
        if (useS3 || value !== "") payload[key] = value
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

  function reset() {
    seeded = false
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
            <Field.Label>App name</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconLetterT />
              </InputGroup.Addon>
              <InputGroup.Input
                value={form["app_name"]}
                oninput={(e) => (form["app_name"] = e.currentTarget.value)}
                aria-invalid={errors["app_name"] ? true : undefined}
              />
            </InputGroup.Root>
            {#if errors["app_name"]}<Field.Error>{errors["app_name"]}</Field.Error>{/if}
          </Field.Field>

          <Field.Field data-invalid={errors["application_url"] ? true : undefined}>
            <Field.Label>Application URL</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconWorld />
              </InputGroup.Addon>
              <InputGroup.Input
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
            <Field.Label>Port</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconNumbers />
              </InputGroup.Addon>
              <InputGroup.Input
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
        <Card.Description>S3-compatible object storage for uploaded files.</Card.Description>
      </Card.Header>
      <Card.Content>
        <div class="flex flex-col gap-4">
          <Field.Group orientation="horizontal">
            <Switch checked={useS3} onCheckedChange={(v) => (useS3 = v)} />
            <Field.Label>Use S3</Field.Label>
          </Field.Group>

          <Field.Field data-invalid={errors["s3_endpoint"] ? true : undefined}>
            <Field.Label>Endpoint</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconWorld />
              </InputGroup.Addon>
              <InputGroup.Input
                value={form["s3_endpoint"]}
                oninput={(e) => (form["s3_endpoint"] = e.currentTarget.value)}
                placeholder="https://s3.amazonaws.com"
                aria-invalid={errors["s3_endpoint"] ? true : undefined}
              />
            </InputGroup.Root>
            {#if errors["s3_endpoint"]}<Field.Error>{errors["s3_endpoint"]}</Field.Error>{/if}
          </Field.Field>

          <Field.Field data-invalid={errors["s3_bucket_name"] ? true : undefined}>
            <Field.Label>Bucket</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconBucket />
              </InputGroup.Addon>
              <InputGroup.Input
                value={form["s3_bucket_name"]}
                oninput={(e) => (form["s3_bucket_name"] = e.currentTarget.value)}
                aria-invalid={errors["s3_bucket_name"] ? true : undefined}
              />
            </InputGroup.Root>
            {#if errors["s3_bucket_name"]}<Field.Error>{errors["s3_bucket_name"]}</Field.Error>{/if}
          </Field.Field>

          <Field.Field data-invalid={errors["s3_region_name"] ? true : undefined}>
            <Field.Label>Region</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconMapPin />
              </InputGroup.Addon>
              <InputGroup.Input
                value={form["s3_region_name"]}
                oninput={(e) => (form["s3_region_name"] = e.currentTarget.value)}
                placeholder="us-east-1"
                aria-invalid={errors["s3_region_name"] ? true : undefined}
              />
            </InputGroup.Root>
            {#if errors["s3_region_name"]}<Field.Error>{errors["s3_region_name"]}</Field.Error>{/if}
          </Field.Field>

          <Field.Field data-invalid={errors["s3_access_key"] ? true : undefined}>
            <Field.Label>Access key</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconKey />
              </InputGroup.Addon>
              <InputGroup.Input
                class="font-mono"
                type={isRevealed("s3_access_key") ? "text" : "password"}
                value={form["s3_access_key"]}
                oninput={(e) => (form["s3_access_key"] = e.currentTarget.value)}
                aria-invalid={errors["s3_access_key"] ? true : undefined}
              />
              <InputGroup.Addon align="inline-end">
                {@render RevealButton({
                  revealed: isRevealed("s3_access_key"),
                  onToggle: () => toggleReveal("s3_access_key")
                })}
              </InputGroup.Addon>
            </InputGroup.Root>
            {#if errors["s3_access_key"]}<Field.Error>{errors["s3_access_key"]}</Field.Error>{/if}
          </Field.Field>

          <Field.Field data-invalid={errors["s3_secret"] ? true : undefined}>
            <Field.Label>Secret key</Field.Label>
            <InputGroup.Root>
              <InputGroup.Addon>
                <IconLock />
              </InputGroup.Addon>
              <InputGroup.Input
                class="font-mono"
                type={isRevealed("s3_secret") ? "text" : "password"}
                value={form["s3_secret"]}
                oninput={(e) => (form["s3_secret"] = e.currentTarget.value)}
                aria-invalid={errors["s3_secret"] ? true : undefined}
              />
              <InputGroup.Addon align="inline-end">
                {@render RevealButton({
                  revealed: isRevealed("s3_secret"),
                  onToggle: () => toggleReveal("s3_secret")
                })}
              </InputGroup.Addon>
            </InputGroup.Root>
            {#if errors["s3_secret"]}<Field.Error>{errors["s3_secret"]}</Field.Error>{/if}
          </Field.Field>
        </div>
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title class="text-sm">Logs</Card.Title>
        <Card.Description>How long the log-cleanup cron keeps records.</Card.Description>
      </Card.Header>
      <Card.Content>
        <Field.Field data-invalid={errors["log_retention_days"] ? true : undefined}>
          <Field.Label>Retention (days)</Field.Label>
          <InputGroup.Root>
            <InputGroup.Addon>
              <IconClock />
            </InputGroup.Addon>
            <InputGroup.Input
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

    <div class="flex items-center justify-end gap-2">
      <Button variant="outline" onclick={reset} disabled={saving}>Reset</Button>
      <Button onclick={save} disabled={!valid || saving}>
        {#if saving}<Spinner />{/if}
        {saving ? "Saving…" : "Save changes"}
      </Button>
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
    <Field.Label>{label}</Field.Label>
    <InputGroup.Root>
      <InputGroup.Addon>
        <IconKey />
      </InputGroup.Addon>
      <InputGroup.Input class="font-mono" type={revealed ? "text" : "password"} {value} readonly />
      <InputGroup.Addon align="inline-end">
        {@render RevealButton({ revealed, onToggle })}
        <InputGroup.Button size="icon-xs" aria-label="Copy value" onclick={onCopy}>
          <IconCopy />
        </InputGroup.Button>
      </InputGroup.Addon>
    </InputGroup.Root>
  </Field.Field>
{/snippet}
