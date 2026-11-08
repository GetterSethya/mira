<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';

  let { data } = $props();

  let activeId = $state('');

  onMount(() => {
    const headings = [
      ...document.querySelectorAll<HTMLElement>('.prose h2[id], .prose h3[id]')
    ];
    if (headings.length === 0) return;

    const setActive = () => {
      let current = headings[0]?.id ?? '';
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= 120) current = heading.id;
      }
      activeId = current;
    };

    setActive();
    window.addEventListener('scroll', setActive, { passive: true });
    return () => window.removeEventListener('scroll', setActive);
  });
</script>

<svelte:head>
  <title>{data.page.title} — Mira docs</title>
  <meta name="description" content={data.page.summary} />
</svelte:head>

<div class="docs-article-layout">
  <article class="docs-article">
    <h1>{data.page.title}</h1>
    <p class="docs-summary">{data.page.summary}</p>

    {#if data.headings.length > 0}
      <details class="docs-toc-mobile">
        <summary>On this page</summary>
        <ul>
          {#each data.headings as heading}
            <li class:depth-3={heading.level === 3}>
              <a
                href={`#${heading.id}`}
                aria-current={activeId === heading.id ? 'location' : undefined}
              >
                {heading.text}
              </a>
            </li>
          {/each}
        </ul>
      </details>
    {/if}

    <div class="prose">{@html data.html}</div>

    <details class="docs-sources">
      <summary>Contract sources</summary>
      <p>
        This page is checked against the package contracts and source folders below. It is
        not a compatibility guarantee.
      </p>
      <ul>
        {#each data.page.contracts as contract}
          <li><code>{contract}</code></li>
        {/each}
        {#each data.page.sourceFolders as folder}
          <li><code>{folder}</code></li>
        {/each}
      </ul>
    </details>

    <nav class="docs-pager" aria-label="Docs pages">
      {#if data.prev}
        <a href={resolve(`/docs/${data.prev.slug}/`)}>
          <span>Previous</span>
          {data.prev.title}
        </a>
      {/if}
      {#if data.next}
        <a href={resolve(`/docs/${data.next.slug}/`)}>
          <span>Next</span>
          {data.next.title}
        </a>
      {/if}
    </nav>
  </article>

  {#if data.headings.length > 0}
    <aside class="docs-toc" aria-label="On this page">
      <p class="docs-toc-title">On this page</p>
      <ul>
        {#each data.headings as heading}
          <li class:depth-3={heading.level === 3}>
            <a
              href={`#${heading.id}`}
              aria-current={activeId === heading.id ? 'location' : undefined}
            >
              {heading.text}
            </a>
          </li>
        {/each}
      </ul>
    </aside>
  {/if}
</div>
