<script lang="ts">
  import { useFieldContext } from "$lib/form-context.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import * as InputGroup from "$lib/components/ui/input-group/index.js"
  import { IconBraces } from "@tabler/icons-svelte"

  const field = useFieldContext<string>()
  const { label }: { label: string } = $props()
  const invalid = $derived(field.state.meta.errors.length > 0)
</script>

<Field.Field data-invalid={invalid || undefined}>
  <Field.Label>{label}</Field.Label>
  <InputGroup.Root class="items-start">
    <InputGroup.Addon class="pt-2">
      <IconBraces />
    </InputGroup.Addon>
    <InputGroup.Textarea
      value={field.state.value}
      oninput={(e) => field.handleChange(e.currentTarget.value)}
      aria-invalid={invalid}
      class="min-h-24 font-mono text-xs"
      rows={6}
    />
  </InputGroup.Root>
  {#if invalid}
    <Field.Error>{field.state.meta.errors[0]}</Field.Error>
  {/if}
</Field.Field>
