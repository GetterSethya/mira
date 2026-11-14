<script lang="ts">
  import Nav from '$lib/components/Nav.svelte';
  import NoticeBar from '$lib/components/NoticeBar.svelte';
  import Footer from '$lib/components/Footer.svelte';

  let { data } = $props();
</script>

<svelte:head>
  <title>Changelog — Mira</title>
  <meta
    name="description"
    content="Every Mira release, generated from the project changelog on GitHub."
  />
</svelte:head>

<a class="skip" href="#main">Skip to content</a>

<div class="top-stack">
  <NoticeBar />
  <Nav />
</div>

<main id="main" class="changelog">
  <div class="container">
    <header class="changelog-hero">
      <p class="eyebrow">Changelog</p>
      <h1>Every release,<br />in one place.</h1>
      <p class="lede">
        Mira ships every package in lockstep. The page reads the project changelog from
        GitHub when the site is built, so the release notes here and in the repository stay
        the same document.
      </p>
      <div class="hero-actions">
        <a class="btn primary" href={data.sourceUrl} target="_blank" rel="noreferrer">
          View on GitHub
        </a>
        <span class="source-note">
          {data.fetchedFromGitHub ? 'Fetched from GitHub' : 'Built from the local checkout'}
        </span>
      </div>
    </header>

    <div class="entries">
      {#each data.entries as entry (entry.version)}
        <article class="entry">
          <header class="entry-head">
            <div class="version-line">
              <h2>{entry.unreleased ? 'Unreleased' : entry.version}</h2>
              {#if entry.unreleased}
                <span class="badge next">Next</span>
              {/if}
              {#if entry.version.includes('-alpha')}
                <span class="badge">Alpha</span>
              {/if}
            </div>
            <div class="meta">
              {#if entry.dateLabel}
                <time datetime={entry.date ?? undefined}>{entry.dateLabel}</time>
              {/if}
              {#if entry.url}
                <a href={entry.url} target="_blank" rel="noreferrer">Release notes</a>
              {/if}
            </div>
          </header>

          {#if entry.html}
            <div class="prose">{@html entry.html}</div>
          {:else}
            <p class="empty">No changes recorded yet.</p>
          {/if}
        </article>
      {/each}
    </div>
  </div>
</main>

<Footer />

<style>
  .top-stack {
    position: sticky;
    top: 0;
    z-index: 40;
  }

  .changelog {
    --docs-inline-bg: #ededed;
    --docs-inline-fg: #1c1c1f;

    padding: 72px 0 96px;
  }

  :global(html[data-theme='dark']) .changelog {
    --docs-inline-bg: #1c1c1f;
    --docs-inline-fg: #e4e4e7;
  }

  .changelog-hero {
    max-width: 760px;
    margin-bottom: 56px;
  }

  .eyebrow {
    margin: 0 0 14px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    color: var(--ink);
    font-size: clamp(40px, 6.2vw, 72px);
    font-weight: 500;
    letter-spacing: var(--tracking-tight);
    line-height: var(--leading-tight);
  }

  .lede {
    max-width: 62ch;
    margin: 24px 0 0;
    color: var(--muted);
    font-size: var(--text-base);
    line-height: var(--leading-body);
  }

  .hero-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px;
    margin-top: 28px;
  }

  .source-note {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .entries {
    display: flex;
    flex-direction: column;
    gap: 28px;
  }

  .entry {
    padding: 28px 32px 34px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
  }

  .entry-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px 24px;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--border);
  }

  .version-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  .version-line h2 {
    margin: 0;
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .badge.next {
    border-color: var(--ink);
    background: var(--ink);
    color: var(--bg);
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .meta a {
    color: var(--ink);
    text-underline-offset: 3px;
  }

  .entry .prose {
    margin-top: 0;
    padding-top: 6px;
  }

  .entry :global(.prose h3) {
    margin-top: 26px;
    font-size: 18px;
  }

  .entry :global(.prose h3:first-child) {
    margin-top: 12px;
  }

  .empty {
    margin: 18px 0 0;
    color: var(--muted);
    font-size: var(--text-sm);
  }

  @media (max-width: 639px) {
    .changelog {
      padding-top: 48px;
    }

    .entry {
      padding: 22px 20px 26px;
    }
  }
</style>
