<script lang="ts">
  import { useFieldContext } from "$lib/form-context.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import * as InputGroup from "$lib/components/ui/input-group/index.js"
  import { IconMail } from "@tabler/icons-svelte"

  const field = useFieldContext<string>()
  const {
    label,
    readonly = false,
    format = null,
    required = false,
    multiline = false
  }: { label: string; readonly?: boolean; format?: string | null; required?: boolean; multiline?: boolean } = $props()
  const uid = $props.id()
  const inputId = `${uid}-input`
  const errorId = `${uid}-error`
  const invalid = $derived(field.state.meta.errors.length > 0)
</script>

<Field.Field data-invalid={invalid || undefined}>
  <Field.Label for={inputId}>{label}</Field.Label>
  {#if multiline}
    <InputGroup.Root class="items-start">
      {#if format === "email"}
        <InputGroup.Addon class="pt-2">
          <IconMail />
        </InputGroup.Addon>
      {/if}
      <InputGroup.Textarea
        id={inputId}
        value={field.state.value}
        oninput={(e) => field.handleChange(e.currentTarget.value)}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        aria-required={required}
        class="min-h-28 text-sm"
        rows={6}
        {readonly}
      />
    </InputGroup.Root>
  {:else}
    <InputGroup.Root>
      {#if format === "email"}
        <InputGroup.Addon>
          <IconMail />
        </InputGroup.Addon>
      {/if}
      <InputGroup.Input
        id={inputId}
        value={field.state.value}
        oninput={(e) => field.handleChange(e.currentTarget.value)}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        aria-required={required}
        {readonly}
      />
    </InputGroup.Root>
  {/if}
  {#if invalid}
    <Field.Error id={errorId}>{field.state.meta.errors[0]}</Field.Error>
  {/if}
</Field.Field>
