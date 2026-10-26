<script lang="ts" module>
	import { tv, type VariantProps } from "tailwind-variants";

	const inputGroupButtonVariants = tv({
		base: "flex items-center gap-1 text-xs/relaxed shadow-none",
		variants: {
			size: {
				xs: "h-5 gap-1 rounded-sm px-1.5 [&>svg:not([class*='size-'])]:size-3.5",
				sm: "h-6 gap-1 rounded-md px-2 [&>svg:not([class*='size-'])]:size-3.5",
				"icon-xs": "size-5 rounded-sm p-0 [&>svg:not([class*='size-'])]:size-3.5",
				"icon-sm": "size-6 rounded-md p-0 [&>svg:not([class*='size-'])]:size-4",
			},
		},
		defaultVariants: {
			size: "xs",
		},
	});

	export type InputGroupButtonSize = VariantProps<typeof inputGroupButtonVariants>["size"];
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import type { ComponentProps } from "svelte";
	import { Button } from "$lib/components/ui/button/index.js";

	let {
		ref = $bindable(null),
		class: className,
		children,
		type = "button",
		variant = "ghost",
		size = "xs",
		...restProps
	}: Omit<ComponentProps<typeof Button>, "href" | "size"> & {
		size?: InputGroupButtonSize;
	} = $props();
</script>

<Button
	bind:ref
	{type}
	data-size={size}
	{variant}
	class={cn(inputGroupButtonVariants({ size }), className)}
	{...restProps}
>
	{@render children?.()}
</Button>
