<script lang="ts">
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { resolve } from '$app/paths';
  import GitHubLink from './GitHubLink.svelte';
  import ThemeToggle from './ThemeToggle.svelte';

  let open = $state(false);
  let solid = $state(false);
  let showCta = $state(false);

  const home = resolve('/');
  const links = [
    { href: `${home}#features`, label: 'Features' },
    { href: `${home}#how-it-works`, label: 'How it works' },
    { href: `${home}#quickstart`, label: 'Quickstart' },
    { href: `${home}#faq`, label: 'FAQ' },
    { href: resolve('/docs/'), label: 'Docs' },
    { href: resolve('/changelog/'), label: 'Changelog' }
  ];

  function close() {
    open = false;
  }

  onMount(() => {
    const onScroll = () => {
      if (window.innerWidth > 767) open = false;

      solid = window.scrollY > 24;
      const hero = document.querySelector('#top');
      const cta = document.querySelector('#cta');
      const pastHero = hero ? hero.getBoundingClientRect().bottom <= 0 : false;
      const ctaVisible = cta ? cta.getBoundingClientRect().top < window.innerHeight : false;
      showCta = pastHero && !ctaVisible;
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  });
</script>

<header class="nav" class:solid>
  <div class="container inner">
    <a class="wordmark" href={resolve('/')} onclick={close}>mira</a>

    <nav class="links" aria-label="Primary">
      {#each links as link}
        <a href={link.href}>{link.label}</a>
      {/each}
    </nav>

    <div class="actions">
      <GitHubLink />
      <ThemeToggle />
      <span class="cta-slot" class:visible={showCta} inert={!showCta} aria-hidden={!showCta}>
        <a class="btn desk-cta" href={`${home}#quickstart`} tabindex={showCta ? 0 : -1}>Quickstart</a>
      </span>
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
    <div
      id="mobile-menu"
      class="mobile"
      transition:fly={{ y: -8, duration: 180 }}
    >
      <nav aria-label="Mobile">
        {#each links as link}
          <a href={link.href} onclick={close}>{link.label}</a>
        {/each}
        <a class="btn mobile-cta" href={`${home}#quickstart`} onclick={close}>Quickstart</a>
      </nav>
    </div>
  {/if}
</header>

<style>
  .nav {
    --nav-fg: var(--hero-fg);
    --nav-line: var(--hero-line);
    --nav-hole: var(--hero-bg);
    /* Opaque chip surfaces so the theme control never sinks into the dither.
       Mixing against nav-hole (always a solid page/hero colour) keeps them
       readable in both themes and both nav states. */
    --nav-chip-bg: color-mix(in srgb, var(--nav-hole) 90%, var(--nav-fg));
    --nav-chip-bg-hover: color-mix(in srgb, var(--nav-hole) 82%, var(--nav-fg));
    --nav-chip-border: color-mix(in srgb, var(--nav-fg) 34%, transparent);
    --nav-cta-bg: var(--ink);
    --nav-cta-fg: var(--bg);

    position: relative;
    z-index: 40;
    border-bottom: 1px solid transparent;
    background: transparent;
    color: var(--nav-fg);
    transition:
      background-color var(--motion-base) var(--ease),
      border-color var(--motion-base) var(--ease);
  }

  /* Top-of-page scrim: a translucent hero-coloured veil plus blur so the
     transparent nav stays legible over the light/dark dither, without
     becoming the heavy `.solid` bar. Fades out as the solid bar fades in. */
  .nav::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--hero-bg) 88%, transparent) 0%,
      color-mix(in srgb, var(--hero-bg) 66%, transparent) 58%,
      color-mix(in srgb, var(--hero-bg) 32%, transparent) 100%
    );
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    opacity: 1;
    pointer-events: none;
    transition: opacity var(--motion-base) var(--ease);
  }

  .nav.solid::before {
    opacity: 0;
  }

  .nav.solid {
    --nav-fg: var(--ink);
    --nav-line: var(--border);
    --nav-hole: var(--bg);
    --nav-cta-bg: var(--ink);
    --nav-cta-fg: var(--bg);

    border-bottom-color: var(--border);
    background: var(--bg);
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: blur(12px);
  }

  .inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    height: 64px;
  }

  .wordmark {
    color: var(--nav-fg);
  }

  .links {
    display: flex;
    align-items: center;
    gap: 28px;
  }

  .links a {
    color: color-mix(in srgb, var(--nav-fg) 80%, transparent);
    font-size: var(--text-sm);
    text-decoration: none;
    transition: color var(--motion-fast) var(--ease);
  }

  .links a:hover {
    color: var(--nav-fg);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .cta-slot {
    display: block;
    max-width: 0;
    margin-left: -8px;
    overflow: hidden;
    opacity: 0;
    transform: translateX(6px);
    pointer-events: none;
    transition:
      max-width 240ms var(--ease),
      margin-left 240ms var(--ease),
      opacity 160ms var(--ease),
      transform 240ms var(--ease);
  }

  .cta-slot.visible {
    max-width: 180px;
    margin-left: 0;
    opacity: 1;
    transform: none;
    pointer-events: auto;
  }

  .cta-slot .desk-cta {
    white-space: nowrap;
  }

  .desk-cta {
    min-height: 36px;
    padding: 0 14px;
    border-color: var(--nav-cta-bg);
    background: var(--nav-cta-bg);
    color: var(--nav-cta-fg);
  }

  .desk-cta:hover {
    opacity: 0.9;
    background: var(--nav-cta-bg);
    border-color: var(--nav-cta-bg);
  }

  .toggle {
    display: none;
    flex-direction: column;
    justify-content: center;
    gap: 5px;
    width: 44px;
    height: 44px;
    padding: 0 11px;
    border: 1px solid var(--nav-line);
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
    border-top: 1px solid var(--nav-line);
    background: var(--hero-bg);
  }

  .nav.solid .mobile {
    background: var(--surface);
  }



  .mobile a {
    display: flex;
    align-items: center;
    min-height: 44px;
    border-bottom: 1px solid var(--nav-line);
    color: var(--nav-fg);
    font-size: var(--text-base);
    text-decoration: none;
  }

  .mobile .mobile-cta {
    margin-top: 14px;
    border-bottom: none;
    border-color: var(--nav-cta-bg);
    background: var(--nav-cta-bg);
    color: var(--nav-cta-fg);
  }

  @media (min-width: 768px) {
    .mobile {
      display: none;
    }
  }

  @media (max-width: 767px) {
    .links,
    .desk-cta,
    .cta-slot {
      display: none;
    }

    .toggle {
      display: inline-flex;
    }
  }
</style>
