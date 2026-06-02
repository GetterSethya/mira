<script lang="ts">
  import { useFieldContext } from "$lib/form-context.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import { Input } from "$lib/components/ui/input/index.js"

  const field = useFieldContext<string>()
  const { label, readonly = false }: { label: string; readonly?: boolean } = $props()
  const invalid = $derived(field.state.meta.errors.length > 0)
</script>

<Field.Field data-invalid={invalid || undefined}>
  <Field.Label>{label}</Field.Label>
  <Input
    value={field.state.value}
    oninput={(e) => field.handleChange((e.target as HTMLInputElement).value)}
    aria-invalid={invalid}
    {readonly}
  />
  {#if invalid}
    <Field.Error>{field.state.meta.errors[0]}</Field.Error>
  {/if}
</Field.Field>
