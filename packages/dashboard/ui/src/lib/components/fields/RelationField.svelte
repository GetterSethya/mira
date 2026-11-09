<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import { useFieldContext } from "$lib/form-context.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import * as InputGroup from "$lib/components/ui/input-group/index.js"
  import * as Select from "$lib/components/ui/select/index.js"
  import { makeCollectionApi } from "$lib/collection-client.js"
  import { IconLink } from "@tabler/icons-svelte"

  const field = useFieldContext<string | null>()
  const { label, collectionName, required = false }: { label: string; collectionName: string; required?: boolean } = $props()
  const uid = $props.id()
  const inputId = `${uid}-input`
  const errorId = `${uid}-error`
  const invalid = $derived(field.state.meta.errors.length > 0)

  const query = createQuery(() => makeCollectionApi(collectionName).listOptions({ limit: 50 }))

  const firstNonSystemKey = (record: Record<string, unknown>) => {
    const systemFields = new Set(["id", "seqId", "created", "updated", "password"])
    return Object.entries(record).find(([k]) => !systemFields.has(k))?.[1] ?? record["id"]
  }
</script>

<Field.Field data-invalid={invalid || undefined}>
  <Field.Label for={inputId}>{label}</Field.Label>
  <Select.Root
    type="single"
    value={field.state.value ?? ""}
    onValueChange={(v) => field.handleChange(v || null)}
  >
    <InputGroup.Root>
      <InputGroup.Addon>
        <IconLink />
      </InputGroup.Addon>
      <Select.Trigger
        id={inputId}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        aria-required={required}
        class="h-full w-full flex-1 justify-between rounded-none border-0 bg-transparent ps-1.5 pe-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent"
      >
        {#if query.data}
          {@const rec = query.data.items.find((r) => r["id"] === field.state.value)}
          {rec ? String(firstNonSystemKey(rec)) : "Select…"}
        {:else}
          Select…
        {/if}
      </Select.Trigger>
    </InputGroup.Root>
    <Select.Content>
      {#if query.isLoading}
        <Select.Item value="" disabled>Loading…</Select.Item>
      {:else if query.data}
        {#each query.data.items as record (record["id"])}
          <Select.Item value={String(record["id"])}>
            {String(firstNonSystemKey(record))}
          </Select.Item>
        {/each}
      {/if}
    </Select.Content>
  </Select.Root>
  {#if invalid}
    <Field.Error id={errorId}>{field.state.meta.errors[0]}</Field.Error>
  {/if}
</Field.Field>
