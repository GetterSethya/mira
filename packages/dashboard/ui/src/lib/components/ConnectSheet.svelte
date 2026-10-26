<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query"
  import type { ApiCollectionSchema } from "@gettersethya/mira-client"
  import { IconCopy, IconDownload } from "@tabler/icons-svelte"
  import { toast } from "svelte-sonner"
  import { run, dashboardApi } from "$lib/dashboard-api.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import { Input } from "$lib/components/ui/input/index.js"
  import * as Sheet from "$lib/components/ui/sheet/index.js"
  import * as Tabs from "$lib/components/ui/tabs/index.js"
  import CodeBlock from "$lib/components/CodeBlock.svelte"
  import { generateCollectionFile, resolveSubset } from "../../../../src/codegen.js"
  import {
    curlSections,
    fetchSections,
    sdkSections,
    type SnippetSection
  } from "../../../../src/snippets.js"

  type ConnectTab = "sdk" | "fetch" | "types"
  type FetchMode = "fetch" | "curl"
  type TypesScope = "current" | "all"

  let {
    open,
    tab,
    schema,
    allSchemas,
    onTabChange,
    onClose
  }: {
    open: boolean
    tab: ConnectTab
    schema: ApiCollectionSchema
    allSchemas: ReadonlyArray<ApiCollectionSchema>
    onTabChange: (tab: ConnectTab) => void
    onClose: () => void
  } = $props()

  function isConnectTab(value: string): value is ConnectTab {
    return value === "sdk" || value === "fetch" || value === "types"
  }

  const configQuery = createQuery(() => ({
    queryKey: ["config"],
    queryFn: () => run(dashboardApi.config()),
    enabled: open
  }))

  let baseUrl = $state("")
  let fetchMode = $state<FetchMode>("fetch")
  let typesScope = $state<TypesScope>("current")
  let generatedAt = $state(new Date().toISOString())

  function configuredApplicationUrl(): string | undefined {
    const data = configQuery.data
    if (data === undefined) return undefined
    return data.applicationUrl.length > 0 ? data.applicationUrl : undefined
  }

  // Seed the editable base URL whenever the sheet opens or the config lands.
  // Falls back to the current origin while loading or if the request fails.
  $effect(() => {
    if (!open) return
    const configured = configuredApplicationUrl()
    const origin = typeof window === "undefined" ? "" : window.location.origin
    const next = configured ?? origin
    if (next.length > 0) baseUrl = next
  })

  // Freeze the generated-file timestamp for one sheet-open session.
  $effect(() => {
    if (open) generatedAt = new Date().toISOString()
  })

  const sdkTabSections = $derived(sdkSections({ schema, allSchemas, baseUrl }))
  const fetchTabSections = $derived(
    fetchMode === "fetch"
      ? fetchSections({ schema, allSchemas, baseUrl })
      : curlSections({ schema, allSchemas, baseUrl })
  )
  const typeSchemas = $derived(
    typesScope === "current" ? resolveSubset(allSchemas, schema.name) : allSchemas
  )
  const generatedFile = $derived(generateCollectionFile(typeSchemas, { generatedAt }))

  async function copyGeneratedFile() {
    try {
      await navigator.clipboard.writeText(generatedFile)
      toast.success("Copied mira.generated.ts")
    } catch {
      toast.error("Failed to copy")
    }
  }

  function downloadGeneratedFile() {
    const blob = new Blob([generatedFile], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "mira.generated.ts"
    anchor.click()
    URL.revokeObjectURL(url)
    toast.success("Downloaded mira.generated.ts")
  }
</script>

{#snippet sectionBlocks(sections: ReadonlyArray<SnippetSection>)}
  <div class="space-y-6">
    {#each sections as section (section.id)}
      <section class="space-y-3">
        <div class="space-y-1">
          <h3 class="text-sm font-medium">{section.heading}</h3>
          <p class="text-muted-foreground text-xs">{section.description}</p>
        </div>
        <div class="space-y-3">
          {#each section.blocks as block (block.id)}
            <CodeBlock
              code={block.code}
              language={block.language}
              label={`${section.heading} · ${block.label}`}
            />
          {/each}
        </div>
      </section>
    {/each}
  </div>
{/snippet}

<Sheet.Root open={open} onOpenChange={(value) => !value && onClose()}>
  <Sheet.Content
    side="right"
    class="data-[side=right]:w-full data-[side=right]:sm:max-w-4xl data-[side=right]:2xl:max-w-5xl overflow-y-auto"
    showCloseButton={false}
  >
    <Sheet.Header class="bg-card sticky top-0 z-30 border-b">
      <Sheet.Title>Connect to {schema.name}</Sheet.Title>
      <Sheet.Description>
        Client setup and HTTP examples for this {schema.kind} collection.
      </Sheet.Description>
    </Sheet.Header>

    <div class="flex-1 space-y-6 px-6 py-4">
      <div class="space-y-1.5">
        <label class="text-xs font-medium" for="connect-base-url">Base URL</label>
        <Input
          id="connect-base-url"
          class="font-mono"
          bind:value={baseUrl}
          placeholder="https://example.com"
        />
      </div>

      <Tabs.Root
        value={tab}
        onValueChange={(value) => {
          if (isConnectTab(value)) onTabChange(value)
        }}
      >
        <Tabs.List class="w-full">
          <Tabs.Trigger value="sdk">SDK</Tabs.Trigger>
          <Tabs.Trigger value="fetch">fetch</Tabs.Trigger>
          <Tabs.Trigger value="types">Types</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="sdk" class="pt-4">
          {@render sectionBlocks(sdkTabSections)}
        </Tabs.Content>

        <Tabs.Content value="fetch" class="space-y-4 pt-4">
          <div
            class="bg-muted inline-flex items-center gap-0.5 rounded-md p-0.5"
            role="group"
            aria-label="Request flavour"
          >
            <Button
              size="xs"
              variant={fetchMode === "fetch" ? "secondary" : "ghost"}
              aria-pressed={fetchMode === "fetch"}
              onclick={() => (fetchMode = "fetch")}
            >
              fetch
            </Button>
            <Button
              size="xs"
              variant={fetchMode === "curl" ? "secondary" : "ghost"}
              aria-pressed={fetchMode === "curl"}
              onclick={() => (fetchMode = "curl")}
            >
              curl
            </Button>
          </div>
          {@render sectionBlocks(fetchTabSections)}
        </Tabs.Content>

        <Tabs.Content value="types" class="space-y-4 pt-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div
              class="bg-muted inline-flex items-center gap-0.5 rounded-md p-0.5"
              role="group"
              aria-label="Generated file scope"
            >
              <Button
                size="xs"
                variant={typesScope === "current" ? "secondary" : "ghost"}
                aria-pressed={typesScope === "current"}
                onclick={() => (typesScope = "current")}
              >
                This collection
              </Button>
              <Button
                size="xs"
                variant={typesScope === "all" ? "secondary" : "ghost"}
                aria-pressed={typesScope === "all"}
                onclick={() => (typesScope = "all")}
              >
                All collections
              </Button>
            </div>
            <div class="flex items-center gap-1">
              <Button variant="outline" size="xs" onclick={copyGeneratedFile}>
                <IconCopy />
                Copy
              </Button>
              <Button variant="outline" size="xs" onclick={downloadGeneratedFile}>
                <IconDownload />
                Download
              </Button>
            </div>
          </div>
          <CodeBlock code={generatedFile} language="ts" label="mira.generated.ts" />
        </Tabs.Content>
      </Tabs.Root>
    </div>

    <Sheet.Footer class="bg-card sticky bottom-0 z-30 border-t">
      <Button class="w-full" variant="outline" onclick={onClose}>Close</Button>
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
