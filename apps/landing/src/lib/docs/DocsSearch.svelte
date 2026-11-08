<script lang="ts">
  import { resolve } from '$app/paths';
  import { searchDocs } from '$lib/docs/content';

  let { onNavigate }: { onNavigate?: () => void } = $props();

  let query = $state('');
  const results = $derived(searchDocs(query));

  function href(slug: string, anchor: string | null) {
    return `${resolve(`/docs/${slug}/`)}${anchor ? `#${anchor}` : ''}`;
  }
</script>

<label class="docs-search">
  <span class="docs-search-label">Search</span>
  <input
    type="search"
    placeholder="Search docs"
    autocomplete="off"
    spellcheck="false"
    aria-label="Search documentation"
    bind:value={query}
    onkeydown={(event) => {
      if (event.key === 'Escape') query = '';
    }}
  />
</label>

{#if query.trim().length >= 2}
  <div class="docs-search-results" aria-live="polite">
    {#if results.length === 0}
      <p>No matches for “{query}”.</p>
    {:else}
      <ul>
        {#each results as result}
          <li>
            <a href={href(result.slug, result.anchor)} onclick={() => onNavigate?.()}>
              <strong>{result.title}</strong>
              <span>{result.context}</span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
