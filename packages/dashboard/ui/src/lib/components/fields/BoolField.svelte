<script lang="ts">
  import { useFieldContext } from "$lib/form-context.js"
  import * as Field from "$lib/components/ui/field/index.js"
  import { Switch } from "$lib/components/ui/switch/index.js"

  const field = useFieldContext<boolean>()
  const { label }: { label: string } = $props()
</script>

<Field.Group orientation="horizontal">
  <Switch
    checked={field.state.value}
    onCheckedChange={(v) => field.handleChange(v)}
  />
  <Field.Label>{label}</Field.Label>
</Field.Group>
