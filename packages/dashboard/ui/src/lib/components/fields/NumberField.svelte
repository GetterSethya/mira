<script lang="ts">
  import { useFieldContext } from "$lib/form-context.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import * as InputGroup from "$lib/components/ui/input-group/index.js"
  import { IconNumbers } from "@tabler/icons-svelte"

  const field = useFieldContext<number>()
  const { label, required = false }: { label: string; required?: boolean } = $props()
  const uid = $props.id()
  const inputId = `${uid}-input`
  const errorId = `${uid}-error`
  const invalid = $derived(field.state.meta.errors.length > 0)
</script>

<Field.Field data-invalid={invalid || undefined}>
  <Field.Label for={inputId}>{label}</Field.Label>
  <InputGroup.Root>
    <InputGroup.Addon>
      <IconNumbers />
    </InputGroup.Addon>
    <InputGroup.Input
      id={inputId}
      type="number"
      value={field.state.value}
      oninput={(e) => field.handleChange(Number(e.currentTarget.value))}
      aria-invalid={invalid}
      aria-describedby={invalid ? errorId : undefined}
      aria-required={required}
    />
  </InputGroup.Root>
  {#if invalid}
    <Field.Error id={errorId}>{field.state.meta.errors[0]}</Field.Error>
  {/if}
</Field.Field>
