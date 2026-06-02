<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js"
  import { Button } from "$lib/components/ui/button/index.js"
  import ThemeToggle from "$lib/components/ThemeToggle.svelte"
  import { base } from "$app/paths"
</script>

<div class="space-y-4">
  <h1 class="text-2xl font-bold">Settings</h1>

  <div class="grid gap-4 md:grid-cols-2 max-w-2xl">
    <Card.Root>
      <Card.Header>
        <Card.Title class="text-sm">Superadmins</Card.Title>
        <Card.Description>Manage superadmin accounts</Card.Description>
      </Card.Header>
      <Card.Footer>
        <a href="{base}/settings/superadmins">
          <Button variant="outline" size="sm">Manage →</Button>
        </a>
      </Card.Footer>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title class="text-sm">Theme</Card.Title>
        <Card.Description>Switch between light and dark mode</Card.Description>
      </Card.Header>
      <Card.Footer>
        <ThemeToggle />
      </Card.Footer>
    </Card.Root>
  </div>
</div>
