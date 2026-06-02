<script lang="ts">
  import { useFieldContext } from "$lib/form-context.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import { Input } from "$lib/components/ui/input/index.js"

  const field = useFieldContext<File | string | null>()
  const { label }: { label: string } = $props()
  const currentName = $derived(typeof field.state.value === "string" ? field.state.value : null)
</script>

<Field.Field>
  <Field.Label>{label}</Field.Label>
  {#if currentName}
    <Field.Description>Current: {currentName}</Field.Description>
  {/if}
  <Input
    type="file"
    onchange={(e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      field.handleChange(file ?? null)
    }}
  />
</Field.Field>
