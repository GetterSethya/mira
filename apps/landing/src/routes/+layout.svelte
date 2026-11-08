<script lang="ts">
  import '@fontsource-variable/inter';
  import '../app.css';
  import '$lib/docs/docs.css';
  import ScrollToTop from '$lib/components/ScrollToTop.svelte';
  import CodeBlockActions from '$lib/docs/CodeBlockActions.svelte';
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<CodeBlockActions />
<ScrollToTop />
{@render children()}
