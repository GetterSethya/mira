<script lang="ts">
  import { useFieldContext } from "$lib/form-context.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import { Textarea } from "$lib/components/ui/textarea/index.js"

  const field = useFieldContext<string>()
  const { label }: { label: string } = $props()
  const invalid = $derived(field.state.meta.errors.length > 0)
</script>

<Field.Field data-invalid={invalid || undefined}>
  <Field.Label>{label}</Field.Label>
  <Textarea
    value={field.state.value}
    oninput={(e) => field.handleChange((e.target as HTMLTextAreaElement).value)}
    aria-invalid={invalid}
    class="font-mono text-xs"
    rows={6}
  />
  {#if invalid}
    <Field.Error>{field.state.meta.errors[0]}</Field.Error>
  {/if}
</Field.Field>
