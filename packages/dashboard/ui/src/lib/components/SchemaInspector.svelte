<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import { IconAlertTriangle } from "@tabler/icons-svelte"
  import type { CollectionSchema } from "$lib/dashboard-api.js"
  import { dashboardApi, run } from "$lib/dashboard-api.js"
  import { fieldKind, isHiddenField, isSeqIdField } from "$lib/schema.js"
  import {
    indexFindings,
    indexRows,
    ruleRows,
    templateSourceLabel
  } from "$lib/schema-inspection.js"
  import FieldIcon from "$lib/components/FieldIcon.svelte"
  import { Badge } from "$lib/components/ui/badge/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import { Skeleton } from "$lib/components/ui/skeleton/index.js"
  import * as Tabs from "$lib/components/ui/tabs/index.js"

  let { schema, open }: { schema: CollectionSchema; open: boolean } = $props()

  let tab = $state("fields")

  $effect(() => {
    if (tab === "email" && schema.kind !== "auth") tab = "fields"
    if (tab === "view-query" && schema.kind !== "view") tab = "fields"
  })

  const fields = $derived(
    Object.entries(schema.fields).map(([fieldName, field]) => ({
      name: fieldName,
      kind: fieldKind(field),
      required: schema.required?.includes(fieldName) === true,
      hidden: isHiddenField(field) || isSeqIdField(field)
    }))
  )

  const rules = $derived(ruleRows(schema))
  const indexes = $derived(indexRows(schema))

  const emailQuery = createQuery(() => ({
    queryKey: ["email-templates", schema.name],
    queryFn: () => run(dashboardApi.emailTemplates(schema.name)),
    enabled: open && schema.kind === "auth"
  }))
</script>

<Tabs.Root bind:value={tab}>
  <Tabs.List class="h-8 w-full justify-start overflow-x-auto">
    <Tabs.Trigger value="fields" class="flex-none px-2.5">Fields</Tabs.Trigger>
    <Tabs.Trigger value="indexes" class="flex-none px-2.5">Indexes</Tabs.Trigger>
    <Tabs.Trigger value="rules" class="flex-none px-2.5">Rules</Tabs.Trigger>
    {#if schema.kind === "auth"}
      <Tabs.Trigger value="email" class="flex-none px-2.5">Email</Tabs.Trigger>
    {/if}
    {#if schema.kind === "view"}
      <Tabs.Trigger value="view-query" class="flex-none px-2.5">View query</Tabs.Trigger>
    {/if}
  </Tabs.List>

  <Tabs.Content value="fields" class="pt-3">
    <div class="space-y-1">
      {#each fields as field (field.name)}
        <div class="hover:bg-muted/40 flex items-center gap-3 rounded-md px-2 py-2">
          <span class="text-muted-foreground flex size-5 shrink-0 items-center justify-center [&_svg]:size-3.5">
            <FieldIcon name={field.name} field={schema.fields[field.name]} />
          </span>
          <div class="min-w-0 flex-1">
            <p class="font-mono text-[0.8125rem]">{field.name}</p>
            <p class="text-muted-foreground text-xs">{field.kind}</p>
          </div>
          <div class="flex flex-wrap justify-end gap-1">
            {#if field.required}<Badge variant="outline">required</Badge>{/if}
            {#if field.hidden}<Badge variant="outline">hidden</Badge>{/if}
          </div>
        </div>
      {/each}
    </div>
  </Tabs.Content>

  <Tabs.Content value="indexes" class="pt-3">
    <p class="text-muted-foreground text-xs leading-relaxed">
      Field-level <code class="font-mono">unique</code>/<code class="font-mono">indexed</code> are
      TypeScript inputs normalized into <code class="font-mono">x-indexes</code>.
    </p>

    {#if indexes.length === 0}
      <p class="text-muted-foreground mt-3 text-sm">No indexes — filters scan the table.</p>
    {:else}
      <div class="mt-3 space-y-2">
        {#each indexes as row, position (`${row.fields.join(",")}-${position}`)}
          {@const findings = indexFindings(schema, row.index)}
          <div class="rounded-md border p-3">
            <div class="flex flex-wrap items-center gap-1.5">
              {#each row.fields as field (field)}
                <code class="bg-muted rounded px-1.5 py-0.5 font-mono text-[0.75rem]">{field}</code>
              {:else}
                <span class="text-muted-foreground text-xs">No fields</span>
              {/each}
              <Badge variant="outline">{row.kind}</Badge>
              {#if row.unique}<Badge variant="secondary">unique</Badge>{/if}
              {#if row.system}<Badge variant="ghost">system</Badge>{/if}
            </div>

            {#if findings.length > 0}
              <ul class="text-muted-foreground mt-2 space-y-1 text-xs">
                {#each findings as finding (finding)}
                  <li class="flex items-start gap-1.5">
                    <IconAlertTriangle class="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>{finding}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </Tabs.Content>

  <Tabs.Content value="rules" class="pt-3">
    {#if !rules.rulesReported}
      <div class="border-border bg-muted/40 rounded-md border p-3 text-xs leading-relaxed">
        <p class="font-medium">This server doesn't report rules.</p>
        <p class="text-muted-foreground mt-1">
          Update Mira to see each action's rule verdict here. Actions without a rule are denied.
        </p>
      </div>
    {:else if !rules.rulesConfigured}
      <div class="border-border bg-muted/40 rounded-md border p-3 text-xs leading-relaxed">
        <p class="font-medium">Rules aren't configured — every action is denied.</p>
        <p class="text-muted-foreground mt-1">
          Add a <code class="font-mono">rules</code> callback in code to allow specific actions.
        </p>
      </div>
    {:else}
      <p class="text-muted-foreground text-xs leading-relaxed">
        One row per action. Actions without a rule are denied by default.
      </p>
    {/if}

    <div class="mt-3 space-y-2">
      {#each rules.rows as row (row.action)}
        <div class="rounded-md border p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-[0.8125rem] font-medium">{row.label}</p>
            <Badge
              variant={row.kind === "public"
                ? "secondary"
                : row.kind === "deny"
                  ? "destructive"
                  : "outline"}
            >
              {row.verdict}
            </Badge>
          </div>

          {#if row.fields.length > 0}
            <div class="mt-2 flex flex-wrap gap-1">
              {#each row.fields as field (field)}
                <Badge variant="ghost" class="font-mono">{field}</Badge>
              {/each}
            </div>
          {/if}

          {#if row.raw === null}
            <p class="text-muted-foreground mt-2 text-xs">No rule for this action.</p>
          {:else}
            <details class="mt-2">
              <summary class="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
                Raw expression
              </summary>
              <pre class="bg-muted/40 mt-2 max-h-48 overflow-auto rounded-md border p-3 font-mono text-[0.6875rem] leading-relaxed">{JSON.stringify(row.raw, null, 2)}</pre>
            </details>
          {/if}
        </div>
      {/each}
    </div>

    <p class="text-muted-foreground mt-3 text-xs leading-relaxed">
      Display only — the dashboard never evaluates rules. Enforcement happens on the server.
    </p>
  </Tabs.Content>

  {#if schema.kind === "auth"}
    <Tabs.Content value="email" class="pt-3">
      {#if emailQuery.isLoading}
        <div class="space-y-3" role="status" aria-live="polite" aria-busy="true" aria-label="Loading email templates">
          {#each { length: 2 } as _, index (index)}
            <div class="space-y-2 rounded-md border p-3">
              <Skeleton class="h-3 w-32" />
              <Skeleton class="h-3 w-3/4" />
              <Skeleton class="h-16 w-full" />
            </div>
          {/each}
        </div>
      {:else if emailQuery.isError}
        <div class="border-destructive/30 bg-destructive/5 flex flex-col items-start gap-3 rounded-md border p-3" role="alert">
          <div class="flex items-center gap-2">
            <IconAlertTriangle class="text-destructive size-4" />
            <p class="text-sm font-medium">Could not load email templates.</p>
          </div>
          <p class="text-muted-foreground text-xs">
            The preview request failed. The collection schema is still available.
          </p>
          <Button variant="outline" class="h-11 sm:h-9" onclick={() => emailQuery.refetch()}>
            Retry
          </Button>
        </div>
      {:else if emailQuery.data}
        {@const data = emailQuery.data}
        {#if !data.transportEnabled}
          <div class="border-border bg-muted/40 mb-3 rounded-md border p-3 text-xs leading-relaxed">
            <p class="font-medium">Email is not configured on this server.</p>
            <p class="text-muted-foreground mt-1">
              Previews still work — no message will be delivered until a transport is configured.
            </p>
          </div>
        {/if}

        {#if data.templates.length === 0}
          <p class="text-muted-foreground text-sm">No email templates reported for this collection.</p>
        {:else}
          <div class="space-y-3">
            {#each data.templates as template (template.id)}
              <section class="rounded-md border p-3">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <h3 class="text-[0.8125rem] font-medium">{template.label}</h3>
                  <Badge variant="outline">{templateSourceLabel(template.source)}</Badge>
                </div>

                <p class="text-muted-foreground mt-3 text-[0.6875rem] font-medium tracking-wide uppercase">Subject</p>
                <p class="mt-1 font-mono text-xs break-all">{template.subject}</p>

                <p class="text-muted-foreground mt-3 text-[0.6875rem] font-medium tracking-wide uppercase">Text</p>
                <pre class="bg-muted/40 mt-1 max-h-48 overflow-auto rounded-md border p-3 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap">{template.text}</pre>

                <p class="text-muted-foreground mt-3 text-[0.6875rem] font-medium tracking-wide uppercase">HTML</p>
                {#if template.html === null}
                  <p class="text-muted-foreground mt-1 text-xs">No HTML part — the text body is sent as-is.</p>
                {:else}
                  <details class="mt-1">
                    <summary class="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
                      HTML source
                    </summary>
                    <pre class="bg-muted/40 mt-2 max-h-64 overflow-auto rounded-md border p-3 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap">{template.html}</pre>
                  </details>
                {/if}
              </section>
            {/each}
          </div>
        {/if}
      {:else}
        <p class="text-muted-foreground text-sm">No preview available.</p>
      {/if}
    </Tabs.Content>
  {/if}

  {#if schema.kind === "view"}
    <Tabs.Content value="view-query" class="pt-3">
      {#if schema.viewQuery}
        <pre class="bg-muted/40 max-h-64 overflow-auto rounded-md border p-3 font-mono text-[0.6875rem] leading-relaxed">{schema.viewQuery}</pre>
      {:else}
        <p class="text-muted-foreground text-sm">No view query reported for this collection.</p>
      {/if}
    </Tabs.Content>
  {/if}
</Tabs.Root>
