<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/stores';
  import GitHubLink from '$lib/components/GitHubLink.svelte';
  import ThemeToggle from '$lib/components/ThemeToggle.svelte';
  import DocsSearch from '$lib/docs/DocsSearch.svelte';
  import { docsGroups, docsPages } from '$lib/docs/nav';

  let { children }: { children: Snippet } = $props();

  let open = $state(false);
  let mobile = $state(false);
  let sidebar: HTMLElement | undefined = $state();
  let menuButton: HTMLButtonElement | undefined = $state();

  const currentSlug = $derived($page.url.pathname.replace(/\/+$/, '').split('/').at(-1));

  const groups = docsGroups.map((group) => ({
    group,
    pages: docsPages.filter((page) => page.group === group)
  }));

  function close() {
    open = false;
  }

  function closeAndFocus() {
    open = false;
    menuButton?.focus();
  }

  function toggleMenu() {
    open = !open;

    if (open) {
      queueMicrotask(() => sidebar?.focus());
    } else {
      menuButton?.focus();
    }
  }

  onMount(() => {
    const media = window.matchMedia('(max-width: 899px)');
    const syncMobile = () => {
      mobile = media.matches;
      if (!mobile) open = false;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        closeAndFocus();
        return;
      }

      if (event.key === 'Tab' && mobile && open) {
        const focusable = [
          ...(sidebar?.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'
          ) ?? [])
        ];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
    };

    syncMobile();
    media.addEventListener('change', syncMobile);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      media.removeEventListener('change', syncMobile);
      window.removeEventListener('keydown', onKeyDown);
    };
  });
</script>

<svelte:head>
  <meta name="color-scheme" content="light dark" />
</svelte:head>

<a class="docs-skip" href="#content">Skip to content</a>

<div class="docs-shell" class:drawer-open={open}>
  <header class="docs-header">
    <div class="docs-header-inner">
      <a class="docs-wordmark" href={resolve('/')} onclick={close}>
        mira <span>/ docs</span>
      </a>

      <div class="docs-header-actions">
        <span class="docs-alpha">Early pre-alpha</span>
        <GitHubLink />
        <ThemeToggle />
        <button
          class="docs-menu"
          type="button"
          bind:this={menuButton}
          aria-label={open ? 'Close docs menu' : 'Open docs menu'}
          aria-expanded={open}
          aria-controls="docs-sidebar"
          onclick={toggleMenu}
        >
          <span></span>
          <span></span>
        </button>
      </div>
    </div>
  </header>

  <div class="docs-layout">
    {#if open}
      <button
        class="docs-backdrop"
        type="button"
        aria-label="Close docs menu"
        onclick={closeAndFocus}
      ></button>
    {/if}

    <aside
      id="docs-sidebar"
      class="docs-sidebar"
      class:open
      bind:this={sidebar}
      inert={mobile && !open}
      tabindex="-1"
      aria-label="Documentation"
    >
      <div class="docs-drawer-head">
        <span class="docs-drawer-wordmark">mira <span>/ docs</span></span>
        <button
          class="docs-drawer-close"
          type="button"
          aria-label="Close docs menu"
          onclick={closeAndFocus}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      </div>

      <div class="docs-drawer-body">
        <DocsSearch onNavigate={close} />
        <nav aria-label="Documentation">
          {#each groups as { group, pages }}
            <div class="docs-nav-group">
              <p>{group}</p>
              {#each pages as page}
                <a
                  href={resolve(`/docs/${page.slug}/`)}
                  aria-current={page.slug === currentSlug ? 'page' : undefined}
                  onclick={close}
                >
                  {page.title}
                </a>
              {/each}
            </div>
          {/each}
        </nav>
      </div>
    </aside>

    <main id="content" class="docs-main" tabindex="-1">
      {@render children()}
    </main>
  </div>
</div>
