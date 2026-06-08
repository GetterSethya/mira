<script lang="ts" module>
  export type ThemeToggleProps = Omit<ButtonProps, "children" | "href">
</script>

<script lang="ts">
  import { Button, type ButtonProps } from "$lib/components/ui/button/index.js"
  import { cn } from "$lib/utils"
  import Moon from "@tabler/icons-svelte/icons/moon"
  import Sun from "@tabler/icons-svelte/icons/sun"
  import { toggleMode } from "mode-watcher"

  let { class: className, ref, onclick, variant = "outline", size = "icon", ...rest }: ThemeToggleProps = $props()
</script>

<Button
  onclick={(e: any) => {
    toggleMode()
    onclick(e)
  }}
  class={cn("ml-auto", className)}
  {variant}
  {size}
  {...rest}
>
  <Sun class="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 !transition-all dark:scale-0 dark:-rotate-90" />
  <Moon class="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 !transition-all dark:scale-100 dark:rotate-0" />
  <span class="sr-only">Toggle theme</span>
</Button>
