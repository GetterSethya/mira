<script lang="ts">
  import { createAppForm } from "$lib/form.js"
  import { buildDefaultValues, hasFileField, toFormData } from "$lib/schema.js"
  import type { CollectionSchema } from "$lib/dashboard-api.js"
  import RecordFields from "./RecordFields.svelte"
  import { recordFormStore } from "$lib/stores/record-form-store.svelte"

  const {
    schema,
    record,
    onSubmit
  }: {
    schema: CollectionSchema
    record: Record<string, unknown> | null
    onSubmit: (data: FormData | Record<string, unknown>) => Promise<void>
  } = $props()

  const form = createAppForm(() => ({
    defaultValues: buildDefaultValues(schema, record) as Record<string, unknown>,
    onSubmit: async ({ value }: { value: Record<string, unknown> }) => {
      console.log("onSubmit")
      const data = hasFileField(schema) ? toFormData(value) : value
      await onSubmit(data)
    }
  }))

  const isSubmitting = form.useStore((state) => state.isSubmitting)

  $effect(() => {
    recordFormStore.isLoading = isSubmitting.current
  })
</script>

<form
  id="record-form"
  onsubmit={(e) => {
    e.preventDefault()
    e.stopPropagation()
    form.handleSubmit(e)
  }}
>
  <form.AppForm>
    {#snippet children()}
      <div class="flex flex-col gap-4">
        <RecordFields {form} {schema} {record} />
      </div>
    {/snippet}
  </form.AppForm>
</form>
