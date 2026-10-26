<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...props
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="input-group"
	role="group"
	class={cn(
		"group/input-group border-input bg-input/20 dark:bg-input/30 relative flex h-7 w-full min-w-0 items-center rounded-md border transition-colors outline-none",
		"has-[>textarea]:h-auto",

		// Aligned addons.
		"has-[>[data-align=inline-start]]:[&>input]:ps-1.5",
		"has-[>[data-align=inline-end]]:[&>input]:pe-1.5",
		"has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-start]]:[&>input]:pb-2",
		"has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-end]]:[&>input]:pt-2",

		// Focus state.
		"focus-within:border-ring focus-within:ring-ring/30 focus-within:ring-2",

		// Error state.
		"has-[[aria-invalid=true]]:border-destructive has-[[aria-invalid=true]]:ring-destructive/20 has-[[aria-invalid=true]]:ring-2",

		className
	)}
	{...props}
>
	{@render children?.()}
</div>
