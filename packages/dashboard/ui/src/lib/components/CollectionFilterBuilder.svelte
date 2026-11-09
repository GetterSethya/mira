<script lang="ts" module>
  export type FilterConnector = "and" | "or"
  export type FilterOperator =
    | "eq"
    | "neq"
    | "contains"
    | "startsWith"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "is_true"
    | "is_false"
    | "null"
    | "not_null"

  export type FilterCondition = {
    id: string
    field: string
    operator: FilterOperator
    value: string
    negated?: boolean
  }
</script>

<script lang="ts">
  import type { CollectionSchema, FieldSchema } from "$lib/dashboard-api.js"
  import { fieldKind } from "$lib/schema.js"
  import { tick } from "svelte"
  import { cn } from "$lib/utils.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import { Input } from "$lib/components/ui/input/index.js"
  import * as Select from "$lib/components/ui/select/index.js"
  import FieldIcon from "$lib/components/FieldIcon.svelte"
  import { IconPlus, IconSearch, IconTrash, IconX } from "@tabler/icons-svelte"

  type FilterField = { name: string; field: FieldSchema; kind: string }

  let {
    schema,
    conditions = [],
    connectors = [],
    search = "",
    onApply
  }: {
    schema: CollectionSchema
    conditions?: FilterCondition[]
    connectors?: FilterConnector[]
    search?: string
    onApply: (conditions: FilterCondition[], connectors: FilterConnector[]) => void
  } = $props()

  let nextId = 0
  let editing = $state<number | "new" | null>(null)
  let draft = $state<FilterCondition | null>(null)
  let popoverEl = $state<HTMLElement | null>(null)
  let lastTrigger: HTMLElement | null = null
  let filterButton = $state<HTMLButtonElement | null>(null)
  let popoverInlineStyle = $state("")

  const fields = $derived.by((): FilterField[] => {
    return Object.entries(schema.fields)
      .filter(([, field]) => {
        const kind = fieldKind(field)
        if (field["x-hidden"] === true) return false
        if (kind === "seqId" || kind === "file" || kind === "json") return false
        return true
      })
      .map(([name, field]) => ({ name, field, kind: fieldKind(field) }))
  })

  const defaultField = $derived(
    fields.find(
      (entry) => entry.field["x-system"] !== true && (entry.kind === "text" || entry.kind === "literalText")
    ) ??
      fields.find((entry) => entry.field["x-system"] !== true) ??
      fields[0] ??
      null
  )

  const selectedField = $derived(fields.find((entry) => entry.name === draft?.field) ?? null)
  const operators = $derived(operatorsFor(selectedField?.kind ?? "text"))

  function operatorsFor(kind: string): ReadonlyArray<{ value: FilterOperator; label: string; short: string }> {
    if (kind === "bool") {
      return [
        { value: "is_true", label: "is true", short: "true" },
        { value: "is_false", label: "is false", short: "false" }
      ]
    }
    const equality = [
      { value: "eq" as const, label: "is", short: "is" },
      { value: "neq" as const, label: "is not", short: "is not" }
    ]
    if (kind === "number" || kind === "date") {
      return [
        ...equality,
        { value: "gt", label: "is greater than", short: ">" },
        { value: "gte", label: "is at least", short: ">=" },
        { value: "lt", label: "is less than", short: "<" },
        { value: "lte", label: "is at most", short: "<=" },
        { value: "null", label: "is empty", short: "empty" },
        { value: "not_null", label: "is not empty", short: "not empty" }
      ]
    }
    if (kind === "relation") {
      return [...equality, { value: "null", label: "is empty", short: "empty" }, { value: "not_null", label: "is not empty", short: "not empty" }]
    }
    return [
      ...equality,
      { value: "contains", label: "contains", short: "contains" },
      { value: "startsWith", label: "starts with", short: "starts" },
      { value: "null", label: "is empty", short: "empty" },
      { value: "not_null", label: "is not empty", short: "not empty" }
    ]
  }

  function operatorLabel(operator: FilterOperator): string {
    return operatorsFor("text").concat(operatorsFor("number")).concat(operatorsFor("bool")).find((entry) => entry.value === operator)?.short ?? operator
  }

  function defaultValue(field: FilterField): string {
    return field.field["x-literal"]?.[0] ?? ""
  }

  function makeCondition(field: FilterField): FilterCondition {
    return {
      id: `filter-${++nextId}`,
      field: field.name,
      operator: operatorsFor(field.kind)[0].value,
      value: field.kind === "bool" ? "" : defaultValue(field)
    }
  }

  function openNew(trigger?: HTMLElement) {
    if (!defaultField) return
    lastTrigger = trigger ?? null
    positionPopover(trigger)
    draft = makeCondition(defaultField)
    editing = "new"
  }

  function openEdit(index: number, trigger?: HTMLElement) {
    const condition = conditions[index]
    if (!condition) return
    lastTrigger = trigger ?? null
    positionPopover(trigger)
    draft = { ...condition, negated: condition.negated === true }
    editing = index
  }

  function close(restoreFocus = true) {
    editing = null
    draft = null
    popoverEl = null
    if (!restoreFocus) return
    void tick().then(() => {
      const target = lastTrigger?.isConnected ? lastTrigger : filterButton
      target?.focus()
    })
  }

  function patch(value: Partial<FilterCondition>) {
    if (!draft) return
    draft = { ...draft, ...value }
  }

  function changeField(name: string) {
    const field = fields.find((entry) => entry.name === name)
    if (!field) return
    patch({
      field: name,
      operator: operatorsFor(field.kind)[0].value,
      value: field.kind === "bool" ? "" : defaultValue(field)
    })
  }

  function valid(condition: FilterCondition): boolean {
    return (
      condition.operator === "null" ||
      condition.operator === "not_null" ||
      condition.operator === "is_true" ||
      condition.operator === "is_false" ||
      condition.value.trim().length > 0
    )
  }

  function normalizeConnectors(list: FilterConnector[], length: number): FilterConnector[] {
    return Array.from({ length }, (_, index) => list[index] ?? "and")
  }

  function apply() {
    if (!draft || !valid(draft)) return
    if (editing === "new") {
      const nextConditions = [...conditions, draft]
      const nextConnectors =
        conditions.length > 0
          ? [
              ...normalizeConnectors(connectors, conditions.length - 1),
              connectors[conditions.length - 2] ?? ("and" as const)
            ]
          : []
      onApply(nextConditions, nextConnectors)
    } else if (typeof editing === "number") {
      onApply(
        conditions.map((condition, index) => (index === editing ? draft : condition)),
        normalizeConnectors(connectors, Math.max(0, conditions.length - 1))
      )
    }
    close()
  }

  function removeFromChip(index: number) {
    const nextConditions = conditions.filter((_, conditionIndex) => conditionIndex !== index)
    const currentConnectors = normalizeConnectors(connectors, Math.max(0, conditions.length - 1))
    const removeAt = index === 0 ? 0 : index - 1
    onApply(nextConditions, currentConnectors.filter((_, connectorIndex) => connectorIndex !== removeAt))
    if (editing === index) close()
    else {
      void tick().then(() => {
        const chips = [...document.querySelectorAll<HTMLElement>("[data-filter-control]")].filter(
          (element) => element !== filterButton
        )
        const target = chips[Math.min(index, chips.length - 1)] ?? filterButton
        target?.focus()
      })
    }
  }

  function toggleConnector(index: number) {
    const next = normalizeConnectors(connectors, Math.max(0, conditions.length - 1)).map((connector, connectorIndex) =>
      connectorIndex === index ? (connector === "and" ? "or" : "and") : connector
    )
    onApply(conditions, next)
  }


  function removeDraft() {
    if (typeof editing === "number") removeFromChip(editing)
  }

  function handleWindowPointer(event: MouseEvent) {
    if (editing === null) return
    const target = event.target
    if (!(target instanceof Node)) return
    if (popoverEl?.contains(target)) return
    if (target instanceof Element && target.closest("[data-filter-control]")) return
    close(false)
  }

  function handleKeydown(event: KeyboardEvent) {
    if (editing !== null && event.key === "Escape") close()
  }

  function chipValue(condition: FilterCondition): string {
    if (
      condition.operator === "is_true" ||
      condition.operator === "is_false" ||
      condition.operator === "null" ||
      condition.operator === "not_null"
    )
      return ""
    return condition.value
  }

  function positionPopover(trigger: HTMLElement | undefined) {
    if (!trigger) {
      popoverInlineStyle = ""
      return
    }
    const width = Math.min(352, window.innerWidth - 32)
    const rect = trigger.getBoundingClientRect()
    let left = rect.left
    if (left + width > window.innerWidth - 16) left = window.innerWidth - 16 - width
    if (left < 16) left = 16
    popoverInlineStyle = `left: ${Math.round(left - rect.left)}px; width: ${Math.round(width)}px;`
  }

  function connectorClass(connector: FilterConnector): string {
    return connector === "or"
      ? "border border-primary/30 bg-primary/10 text-primary"
      : "border border-border bg-background text-muted-foreground hover:text-foreground"
  }

  function handlePopoverKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault()
      apply()
    }
  }

  function handlePopoverFocusOut(event: FocusEvent) {
    const next = event.relatedTarget
    if (next instanceof Node && popoverEl?.contains(next)) return
    if (next instanceof Element && next.closest('[data-slot="select-content"]')) return
    if (next === lastTrigger) return
    close(false)
  }

  $effect(() => {
    if (editing === null) return
    void tick().then(() => {
      const input = popoverEl?.querySelector<HTMLInputElement>("input[aria-label=\"Filter value\"]")
      if (input) {
        input.focus()
        input.select()
      } else {
        popoverEl?.querySelector<HTMLElement>("button[data-slot=select-trigger]")?.focus()
      }
    })
  })
</script>

<svelte:window onmousedown={handleWindowPointer} onkeydown={handleKeydown} />

<div class="flex flex-wrap items-center gap-2 border-y py-2">
  <div class="relative">
    <button
      type="button"
      data-filter-control
      class="border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground inline-flex h-11 items-center gap-1.5 rounded-full border border-dashed px-2.5 text-xs transition-colors sm:h-8"
      bind:this={filterButton}
      disabled={fields.length === 0}
      aria-haspopup="dialog"
      aria-expanded={editing === "new"}
      onclick={(event) => {
        if (editing === "new") close()
        else openNew(event.currentTarget)
      }}
    >
      <IconPlus class="size-3.5" />
      Filter
    </button>
    {#if editing === "new" && draft}
      <div
        bind:this={popoverEl}
        role="dialog"
        aria-label="New filter condition"
        tabindex="-1"
        onkeydown={handlePopoverKeydown}
        onfocusout={handlePopoverFocusOut}
        style={popoverInlineStyle}
        class="bg-popover absolute top-full z-40 mt-2 max-h-[min(70vh,24rem)] overflow-y-auto rounded-md border p-3 ring-1 ring-foreground/10"
      >
        {@render editor()}
      </div>
    {/if}
  </div>

  {#if search.trim().length > 0}
    <div class="border-border bg-background inline-flex h-11 max-w-full items-center gap-1.5 rounded-full border pl-2.5 text-[0.8125rem] sm:h-8">
      <IconSearch class="text-muted-foreground size-3.5 shrink-0" />
      <span class="text-muted-foreground shrink-0">search</span>
      <span class="max-w-48 truncate font-medium">{search}</span>
    </div>
  {/if}

  {#if conditions.length > 0}
    <div
      role="group"
      aria-label="Filter conditions"
      class={cn(
        "flex flex-wrap items-center gap-2",
        search.trim().length > 0 && "bg-muted/20 rounded-xl p-0.5"
      )}
    >

  {#each conditions as condition, index (condition.id)}
    <div class="flex items-center gap-2 whitespace-nowrap">
    {#if index === 0 && search.trim().length > 0}
      <span class="text-muted-foreground px-1 text-xs">and</span>
    {/if}
    {#if index > 0}
      <button
        type="button"
        class={cn(
          "h-11 rounded-full border px-2.5 text-xs font-medium lowercase transition-colors sm:h-8",
          connectorClass(connectors[index - 1] ?? "and")
        )}
        aria-label={`Connector is ${connectors[index - 1] === "or" ? "OR" : "AND"}; activate to switch to ${connectors[index - 1] === "or" ? "AND" : "OR"}`}
        onclick={() => toggleConnector(index - 1)}
      >
        {connectors[index - 1] === "or" ? "or" : "and"}
      </button>
    {/if}
    <div class="relative flex items-center">
      <div class="border-border bg-background inline-flex h-11 items-center gap-0.5 rounded-full border pl-2.5 text-[0.8125rem] sm:h-8">
        <button
          type="button"
          data-filter-control
          aria-haspopup="dialog"
          aria-expanded={editing === index}
          class="hover:text-foreground inline-flex min-w-0 items-center gap-1.5 text-left [&_svg]:size-3.5"
          onclick={(event) => {
            if (editing === index) close()
            else openEdit(index, event.currentTarget)
          }}
        >
          <FieldIcon name={condition.field} field={schema.fields[condition.field]} />
          <span class="text-foreground shrink-0 font-medium">{condition.field}</span>
          <span class="text-muted-foreground shrink-0">{operatorLabel(condition.operator)}</span>
          {#if chipValue(condition)}
            <span class="max-w-32 truncate font-medium">{chipValue(condition)}</span>
          {/if}
        </button>
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground mr-1.5 inline-flex size-11 shrink-0 items-center justify-center rounded-full sm:size-7"
          aria-label={`Remove filter ${condition.field}`}
          onclick={() => removeFromChip(index)}
        >
          <IconX class="size-3" />
        </button>
      </div>

      {#if editing === index && draft}
        <div
          bind:this={popoverEl}
          role="dialog"
          aria-label="Edit filter condition"
          tabindex="-1"
          onkeydown={handlePopoverKeydown}
          onfocusout={handlePopoverFocusOut}
          style={popoverInlineStyle}
          class="bg-popover absolute top-full z-40 mt-2 max-h-[min(70vh,24rem)] overflow-y-auto rounded-md border p-3 ring-1 ring-foreground/10"
        >
          {@render editor()}
        </div>
      {/if}
    </div>
    </div>
  {/each}

    </div>
  {/if}
</div>

{#snippet editor()}
  {#if draft}
    <div class="space-y-3">
      <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <div class="space-y-1">
          <span class="text-muted-foreground text-[0.8125rem]">Field</span>
          <Select.Root type="single" value={draft.field} onValueChange={(value) => changeField(value)}>
          <Select.Trigger class="!h-11 w-full sm:!h-9" aria-label="Filter field">
            {#if selectedField}
              <span class="flex min-w-0 items-center gap-1.5 [&_svg]:size-3.5">
                <FieldIcon name={selectedField.name} field={selectedField.field} />
                <span class="truncate">{selectedField.name}</span>
              </span>
            {:else}
              Field
            {/if}
          </Select.Trigger>
          <Select.Content>
            {#each fields as entry (entry.name)}
              <Select.Item value={entry.name}>
                <span class="flex items-center gap-2 [&_svg]:size-3.5">
                  <FieldIcon name={entry.name} field={entry.field} />
                  {entry.name}
                </span>
              </Select.Item>
            {/each}
          </Select.Content>
          </Select.Root>
        </div>

        <div class="space-y-1">
          <span class="text-muted-foreground text-[0.8125rem]">Operator</span>
          <Select.Root
            type="single"
            value={draft.operator}
          onValueChange={(value) => {
            const operator = operators.find((entry) => entry.value === value)
            if (operator) patch({ operator: operator.value })
          }}
        >
          <Select.Trigger class="!h-11 w-full sm:!h-9" aria-label="Filter operator">
            {operators.find((entry) => entry.value === draft.operator)?.label ?? "Operator"}
          </Select.Trigger>
          <Select.Content>
            {#each operators as entry (entry.value)}
              <Select.Item value={entry.value}>{entry.label}</Select.Item>
            {/each}
          </Select.Content>
          </Select.Root>
        </div>
      </div>

      <div class="space-y-1">
        <span class="text-muted-foreground text-[0.8125rem]">Value</span>
        {#if draft.operator === "null" || draft.operator === "not_null" || draft.operator === "is_true" || draft.operator === "is_false"}
        <div class="text-muted-foreground flex h-9 items-center text-xs">No value needed</div>
      {:else if selectedField?.field["x-literal"]}
        <Select.Root type="single" value={draft.value} onValueChange={(value) => patch({ value })}>
          <Select.Trigger class="!h-11 w-full sm:!h-9" aria-label="Filter value">
            {draft.value.length > 0 ? draft.value : "Choose a value"}
          </Select.Trigger>
          <Select.Content>
            {#each selectedField.field["x-literal"] as literal (literal)}
              <Select.Item value={literal}>{literal}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      {:else}
        <Input
          class="h-11 sm:h-9"
          type={selectedField?.kind === "number" ? "number" : selectedField?.kind === "date" ? "date" : "text"}
          placeholder={selectedField?.kind === "relation" ? "Record ID" : "Value"}
          aria-label="Filter value"
          value={draft.value}
          oninput={(event) => patch({ value: event.currentTarget.value })}
        />
        {/if}
      </div>

      {#if !valid(draft)}
        <p id="filter-value-hint" class="text-muted-foreground text-xs">Enter a value to enable the filter.</p>
      {/if}

      <div class="flex items-center justify-between gap-2 border-t pt-3">
        {#if typeof editing === "number"}
          <Button variant="ghost" class="h-11 text-destructive sm:h-9" onclick={removeDraft}>
            <IconTrash class="size-3.5" />
            Remove
          </Button>
        {:else}
          <span></span>
        {/if}
        <div class="flex items-center gap-1">
          <Button variant="ghost" class="h-11 sm:h-9" onclick={() => close()}>Cancel</Button>
          <Button
            class="bg-foreground text-background hover:bg-foreground/90 h-11 sm:h-9"
            aria-describedby={!valid(draft) ? "filter-value-hint" : undefined}
            disabled={!valid(draft)}
            onclick={apply}
          >
            {editing === "new" ? "Add filter" : "Apply"}
          </Button>
        </div>
      </div>
    </div>
  {/if}
{/snippet}
