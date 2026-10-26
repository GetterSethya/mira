<script lang="ts">
  import { useFieldContext } from "$lib/form-context.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import * as InputGroup from "$lib/components/ui/input-group/index.js"
  import { IconLock } from "@tabler/icons-svelte"

  const field = useFieldContext<string>()
  const { label, readonly = false }: { label: string; readonly?: boolean } = $props()
  const invalid = $derived(field.state.meta.errors.length > 0)
</script>

<Field.Field data-invalid={invalid || undefined}>
  <Field.Label>{label}</Field.Label>
  <InputGroup.Root>
    <InputGroup.Addon>
      <IconLock />
    </InputGroup.Addon>
    <InputGroup.Input
      type="password"
      autocomplete="new-password"
      placeholder="Leave blank to keep unchanged"
      value={field.state.value}
      oninput={(e) => field.handleChange(e.currentTarget.value)}
      aria-invalid={invalid}
      {readonly}
    />
  </InputGroup.Root>
  {#if invalid}
    <Field.Error>{field.state.meta.errors[0]}</Field.Error>
  {/if}
</Field.Field>
