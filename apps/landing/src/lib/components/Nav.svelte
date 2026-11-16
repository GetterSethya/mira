<script lang="ts">
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import GitHubLink from './GitHubLink.svelte';
  import ThemeToggle from './ThemeToggle.svelte';

  let open = $state(false);

  const home = resolve('/');
  const links = [
    { href: `${home}#features`, label: 'Features', match: null },
    { href: resolve('/docs/'), label: 'Docs', match: '/docs' },
    { href: resolve('/benchmarks/'), label: 'Benchmarks', match: '/benchmarks' },
    { href: resolve('/changelog/'), label: 'Changelog', match: '/changelog' }
  ] as const;

  const active = (match: string | null) =>
    match !== null && page.url.pathname.split('/').includes(match.replace('/', ''));

  function close() {
    open = false;
  }

  onMount(() => {
    const onResize = () => {
      if (window.innerWidth > 767) open = false;
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });
</script>

<header class="nav">
  <div class="container inner">
    <a class="wordmark" href={resolve('/')} onclick={close}>mira</a>

    <nav class="links" aria-label="Primary">
      {#each links as link}
        <a
          href={link.href}
          class:active={active(link.match)}
          aria-current={active(link.match) ? 'page' : undefined}
        >{link.label}</a>
      {/each}
    </nav>

    <div class="actions">
      <GitHubLink />
      <ThemeToggle />
      <a class="quickstart" href={`${home}#quickstart`}>Quickstart</a>
      <button
        class="toggle"
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="mobile-menu"
        onclick={() => (open = !open)}
      >
        <span class="bar" class:open></span>
        <span class="bar" class:open></span>
      </button>
    </div>
  </div>

  {#if open}
    <div id="mobile-menu" class="mobile" transition:fly={{ y: -8, duration: 180 }}>
      <nav aria-label="Mobile">
        {#each links as link}
          <a
            href={link.href}
            class:active={active(link.match)}
            aria-current={active(link.match) ? 'page' : undefined}
            onclick={close}>{link.label}</a
          >
        {/each}
        <a class="mobile-cta" href={`${home}#quickstart`} onclick={close}>Quickstart</a>
      </nav>
    </div>
  {/if}
</header>

<style>
  .nav {
    --nav-fg: var(--ink);
    --nav-line: var(--border);
    --nav-chip-bg-hover: var(--code-bg);

    position: relative;
    z-index: 40;
    background: var(--surface);
    color: var(--nav-fg);
    transition: background-color var(--motion-base) var(--ease);
  }

  .inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    height: 64px;
  }

  .wordmark {
    flex: none;
    color: var(--nav-fg);
    font-family: var(--font-mono);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.04em;
    text-decoration: none;
  }

  .links {
    display: flex;
    align-items: center;
    gap: 26px;
    margin-left: auto;
    margin-right: auto;
  }

  .links a {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
    transition: color var(--motion-fast) var(--ease);
  }

  .links a:hover,
  .links a.active {
    color: var(--ink);
  }

  .links a.active {
    padding-bottom: 3px;
    border-bottom: 2px solid currentColor;
    color: var(--ink);
    font-weight: 600;
  }

  .actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
  }

  .quickstart {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 36px;
    margin-left: 6px;
    padding: 0 15px;
    border-radius: var(--radius-sm);
    background: var(--ink);
    color: var(--bg);
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
    transition: opacity var(--motion-fast) var(--ease);
  }

  .quickstart:hover {
    opacity: 0.86;
  }

  .toggle {
    display: none;
    flex-direction: column;
    justify-content: center;
    gap: 5px;
    width: 44px;
    height: 44px;
    padding: 0 11px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--nav-fg);
    cursor: pointer;
  }

  .bar {
    display: block;
    height: 1.5px;
    background: currentColor;
    transition: transform var(--motion-fast) var(--ease);
  }

  .bar.open:first-child {
    transform: translateY(3.25px) rotate(45deg);
  }

  .bar.open:last-child {
    transform: translateY(-3.25px) rotate(-45deg);
  }

  .mobile {
    position: absolute;
    top: 100%;
    right: 0;
    left: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: calc(100svh - 100px);
    padding: 8px var(--gutter) 20px;
    overflow-y: auto;
    background: var(--surface);
  }

  .mobile a {
    display: flex;
    align-items: center;
    min-height: 46px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 15px;
    font-weight: 500;
    text-decoration: none;
  }

  .mobile a.active {
    border-bottom: 2px solid currentColor;
    color: var(--ink);
    font-weight: 600;
  }

  .mobile .mobile-cta {
    justify-content: center;
    min-height: 44px;
    margin-top: 12px;
    border-radius: var(--radius-sm);
    background: var(--ink);
    color: var(--bg);
  }

  @media (min-width: 768px) {
    .mobile {
      display: none;
    }
  }

  @media (max-width: 980px) {
    .links {
      gap: 18px;
    }
  }

  @media (max-width: 767px) {
    .links,
    .quickstart {
      display: none;
    }

    .toggle {
      display: inline-flex;
    }
  }
</style>
