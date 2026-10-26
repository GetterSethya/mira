<script lang="ts">
	import { Tabs as TabsPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		...restProps
	}: TabsPrimitive.TriggerProps = $props();
</script>

<TabsPrimitive.Trigger
	bind:ref
	{value}
	data-slot="tabs-trigger"
	class={cn(
		"focus-visible:border-ring focus-visible:ring-ring/30 data-[state=active]:bg-background data-[state=active]:text-foreground dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-sm border border-transparent px-2 py-1 text-xs/relaxed font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
		className
	)}
	{...restProps}
/>
