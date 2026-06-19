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

  const entries = $derived(fieldEntries(schema, record !== null))
</script>

{#each entries as { name, kind, label, collectionName } (name)}
  <form.AppField {name}>
    {#snippet children(field)}
      {#if kind === "relation" && collectionName}
        <field.RelationField {label} {collectionName} />
      {:else if kind === "file"}
        <field.FileField {label} />
      {:else if kind === "bool"}
        <field.BoolField {label} />
      {:else if kind === "number"}
        <field.NumberField {label} />
      {:else if kind === "date"}
        <field.DateField {label} />
      {:else if kind === "json"}
        <field.JsonField {label} />
      {:else}
        <field.TextField {label} />
      {/if}
    {/snippet}
  </form.AppField>
{/each}
