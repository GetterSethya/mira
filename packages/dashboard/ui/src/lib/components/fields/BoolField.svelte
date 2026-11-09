<script lang="ts">
  import { useFieldContext } from "$lib/form-context.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import { Switch } from "$lib/components/ui/switch/index.js"

  const field = useFieldContext<boolean>()
  const { label, required = false }: { label: string; required?: boolean } = $props()
  const uid = $props.id()
  const errorId = `${uid}-error`
  const invalid = $derived(field.state.meta.errors.length > 0)
</script>

<Field.Group orientation="horizontal">
  <Switch
    id={uid}
    checked={field.state.value}
    onCheckedChange={(v) => field.handleChange(v)}
    aria-invalid={invalid}
    aria-describedby={invalid ? errorId : undefined}
    aria-required={required}
  />
  <Field.Label for={uid}>{label}</Field.Label>
  {#if invalid}
    <Field.Error id={errorId}>{field.state.meta.errors[0]}</Field.Error>
  {/if}
</Field.Group>
