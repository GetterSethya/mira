<script lang="ts">
	import { IconCopy } from "@tabler/icons-svelte";
	import { toast } from "svelte-sonner";
	import { Button } from "$lib/components/ui/button/index.js";
	import { Skeleton } from "$lib/components/ui/skeleton/index.js";
	import { highlight, type SnippetLanguage } from "$lib/shiki.js";

	let {
		code,
		language,
		label,
	}: { code: string; language: SnippetLanguage; label: string } = $props();

	let html = $state<string | null>(null);
	let loading = $state(true);

	$effect(() => {
		const currentCode = code;
		const currentLanguage = language;
		let cancelled = false;

		loading = true;
		html = null;

		void highlight(currentCode, currentLanguage)
			.then((result) => {
				if (cancelled) return;
				html = result;
			})
			.catch(() => {
				if (cancelled) return;
				html = null;
			})
			.finally(() => {
				if (!cancelled) loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	async function copyCode() {
		try {
			await navigator.clipboard.writeText(code);
			toast.success("Copied");
		} catch {
			toast.error("Failed to copy");
		}
	}
</script>

<div class="bg-muted/50 overflow-hidden rounded-md border">
	<div class="bg-muted/50 flex items-center justify-between gap-2 border-b py-1 pr-1 pl-3">
		<span class="text-muted-foreground truncate font-mono text-[0.6875rem]">{label}</span>
		<Button
			variant="ghost"
			size="icon-xs"
			aria-label="Copy code"
			title="Copy code"
			disabled={loading}
			onclick={copyCode}
		>
			<IconCopy />
		</Button>
	</div>
	<div class="overflow-x-auto p-3 text-xs/relaxed">
		{#if html !== null}
			<div class="font-mono [&_pre]:m-0 [&_pre]:p-0 [&_pre]:bg-transparent">
				{@html html}
			</div>
		{:else if loading}
			<Skeleton class="h-20 w-full" />
		{:else}
			<pre class="font-mono whitespace-pre">{code}</pre>
		{/if}
	</div>
</div>
