<script lang="ts">
  import type { FieldSchema } from "$lib/dashboard-api.js"
  import { fieldKind } from "$lib/schema.js"
  import {
    IconBraces,
    IconCalendar,
    IconCircleCheck,
    IconFiles,
    IconHash,
    IconLetterT,
    IconLink,
    IconLock,
    IconMail,
    IconNumbers,
    IconUser
  } from "@tabler/icons-svelte"

  const { name, field }: { name: string; field: FieldSchema } = $props()
  const kind = $derived(fieldKind(field))
</script>

{#if name === "email" || field.format === "email"}
  <IconMail />
{:else if name === "created" || name === "updated"}
  <IconCalendar />
{:else if name === "id" || name === "seqId"}
  <IconHash />
{:else if name === "name"}
  <IconUser />
{:else if kind === "number"}
  <IconNumbers />
{:else if kind === "date"}
  <IconCalendar />
{:else if kind === "bool"}
  <IconCircleCheck />
{:else if kind === "relation"}
  <IconLink />
{:else if kind === "file"}
  <IconFiles />
{:else if kind === "json"}
  <IconBraces />
{:else if kind === "password"}
  <IconLock />
{:else}
  <IconLetterT />
{/if}
