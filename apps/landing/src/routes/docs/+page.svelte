<script lang="ts">
  import { resolve } from '$app/paths';
  import { docsGroups, docsPages } from '$lib/docs/nav';

  const groups = docsGroups.map((group) => ({
    group,
    pages: docsPages.filter((page) => page.group === group)
  }));
</script>

<svelte:head>
  <title>Mira docs</title>
  <meta
    name="description"
    content="Install Mira, define collections, add auth and rules, query records, and call the API."
  />
</svelte:head>

<div class="docs-index">
  <h1>Mira documentation</h1>
  <p class="docs-lede">
    Start with the install path, then move through collections, auth, rules, and queries.
    Mira runs on Node or Bun 1.3.14+; the Bun runtime page covers the native preset, SQLite path, Bun.CryptoHasher, Bun.password, and Bun.Image thumbnails.
    Each page is checked against the package contracts and the source it documents. The API reference is generated from the same source with TypeDoc.
  </p>

  <a class="docs-start" href={resolve('/docs/getting-started/')}>Start with getting started</a>

  {#each groups as { group, pages }}
    <section>
      <h2>{group}</h2>
      <div class="docs-list">
        {#each pages as page}
          <a class="docs-list-item" href={resolve(`/docs/${page.slug}/`)}>
            <strong>{page.title}</strong>
            <span>{page.summary}</span>
          </a>
        {/each}
      </div>
    </section>
  {/each}
</div>
