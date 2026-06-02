<script lang="ts">
  import { useFormContext } from "$lib/form-context.js"
  import { Button } from "$lib/components/ui/button/index.js"

  const form = useFormContext()
  const { label = "Submit" }: { label?: string } = $props()
</script>

<form.Subscribe selector={(s) => s.isSubmitting}>
  {#snippet children(isSubmitting)}
    <Button type="submit" disabled={isSubmitting}>{isSubmitting ? "Saving…" : label}</Button>
  {/snippet}
</form.Subscribe>
