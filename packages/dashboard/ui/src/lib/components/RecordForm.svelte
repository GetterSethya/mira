<script lang="ts">
  import { createAppForm } from "$lib/form.js"
  import { buildDefaultValues, hasFileField, toFormData, fieldEntries } from "$lib/schema.js"
  import type { CollectionSchema } from "$lib/client.js"
  import RecordFields from "./RecordFields.svelte"

  const {
    schema,
    record,
    onSubmit,
  }: {
    schema: CollectionSchema
    record: Record<string, unknown> | null
    onSubmit: (data: FormData | Record<string, unknown>) => Promise<void>
  } = $props()

  const form = createAppForm(() => ({
    defaultValues: buildDefaultValues(schema, record) as Record<string, unknown>,
    onSubmit: async ({ value }: { value: Record<string, unknown> }) => {
      const data = hasFileField(schema) ? toFormData(value) : value
      await onSubmit(data)
    },
  }))
</script>

<form.AppForm>
  {#snippet children()}
    <div class="flex flex-col gap-4">
      <RecordFields {form} {schema} {record} />
      <form.SubmitButton label={record ? "Save changes" : "Create"} />
    </div>
  {/snippet}
</form.AppForm>
