<script lang="ts">
  import { getFormType } from "$lib/form.js"
  import { fieldEntries } from "$lib/schema.js"
  import type { CollectionSchema } from "$lib/dashboard-api.js"

  const formType = getFormType({ defaultValues: {} as Record<string, unknown> })
  const {
    form,
    schema,
    record
  }: { form: typeof formType; schema: CollectionSchema; record: Record<string, unknown> | null } = $props()

  const entries = $derived(fieldEntries(schema))
</script>

<p class="text-muted-foreground text-xs">Fields marked * are required.</p>
{#each entries as { name, kind, label, collectionName, format, required } (name)}
  {@const isRequired = required && !(record !== null && kind === "password")}
  {@const displayLabel = isRequired ? `${label} *` : label}
  {@const multiline = ["body", "content", "description", "bio", "message", "notes"].includes(name)}
  <form.AppField {name}>
    {#snippet children(field)}
      {#if kind === "relation" && collectionName}
        <field.RelationField label={displayLabel} {collectionName} required={isRequired} />
      {:else if kind === "file"}
        <field.FileField label={displayLabel} required={isRequired} />
      {:else if kind === "password"}
        <field.PasswordField label={displayLabel} required={isRequired} />
      {:else if kind === "bool"}
        <field.BoolField label={displayLabel} required={isRequired} />
      {:else if kind === "number"}
        <field.NumberField label={displayLabel} required={isRequired} />
      {:else if kind === "date"}
        <field.DateField label={displayLabel} required={isRequired} />
      {:else if kind === "json"}
        <field.JsonField label={displayLabel} required={isRequired} />
      {:else}
        <field.TextField label={displayLabel} {format} required={isRequired} {multiline} />
      {/if}
    {/snippet}
  </form.AppField>
{/each}
