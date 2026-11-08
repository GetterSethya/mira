<script lang="ts">
  import { onMount } from 'svelte';
  import { toggleTheme } from '$lib/theme';

  let open = $state(false);
  let solid = $state(false);

  const links = [
    { href: '#features', label: 'Features' },
    { href: '#how-it-works', label: 'How it works' },
    { href: '#quickstart', label: 'Quickstart' },
    { href: '#faq', label: 'FAQ' }
  ];

  function close() {
    open = false;
  }

  onMount(() => {
    const onScroll = () => {
      solid = window.scrollY > 24;
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => window.removeEventListener('scroll', onScroll);
  });
</script>

<header class="nav" class:solid>
  <div class="container inner">
    <a class="wordmark" href="#top" onclick={close}>
      <svg viewBox="0 0 8 8" aria-hidden="true">
        <rect class="mark" width="8" height="8" />
        <rect x="2" y="2" width="2" height="2" />
        <rect x="6" y="2" width="2" height="2" />
        <rect x="2" y="6" width="2" height="2" />
      </svg>
      mira
    </a>

    <nav class="links" aria-label="Primary">
      {#each links as link}
        <a href={link.href}>{link.label}</a>
      {/each}
    </nav>

    <div class="actions">
      <button
        class="theme"
        type="button"
        aria-label="Toggle light and dark theme"
        title="Toggle light and dark theme"
        onclick={toggleTheme}
      >
        <svg class="icon sun" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.42-1.42"
          />
        </svg>
        <svg class="icon moon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
        </svg>
        <span class="theme-label" aria-hidden="true">Theme</span>
      </button>
      <a class="btn desk-cta" href="#quickstart">Open the quickstart</a>
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

  <div id="mobile-menu" class="mobile" hidden={!open}>
    <nav aria-label="Mobile">
      {#each links as link}
        <a href={link.href} onclick={close}>{link.label}</a>
      {/each}
      <a class="btn mobile-cta" href="#quickstart" onclick={close}>Open the quickstart</a>
    </nav>
  </div>
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

  .wordmark svg .mark {
    fill: currentColor;
  }

  .wordmark svg rect:not(.mark) {
    fill: var(--nav-hole);
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

  .theme {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    min-width: 44px;
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid var(--nav-chip-border);
    border-radius: var(--radius-sm);
    background: var(--nav-chip-bg);
    color: var(--nav-fg);
    font-size: var(--text-xs);
    font-weight: 500;
    letter-spacing: 0.02em;
    line-height: 1;
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--ease),
      border-color var(--motion-fast) var(--ease),
      color var(--motion-fast) var(--ease);
  }

  .theme:hover {
    border-color: color-mix(in srgb, var(--nav-fg) 68%, transparent);
    background: var(--nav-chip-bg-hover);
    color: var(--nav-fg);
  }

  .theme:active {
    background: color-mix(in srgb, var(--nav-hole) 74%, var(--nav-fg));
  }

  .theme:focus-visible {
    outline: 2px solid var(--nav-fg);
    outline-offset: 2px;
  }

  .theme-label {
    display: none;
    line-height: 1;
  }

  .icon {
    width: 19px;
    height: 19px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .icon.moon {
    display: block;
  }

  .icon.sun {
    display: none;
  }

  :global(html[data-theme='dark']) .icon.sun {
    display: block;
  }

  :global(html[data-theme='dark']) .icon.moon {
    display: none;
  }

  .desk-cta {
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
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px var(--gutter) 20px;
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

  /* Icon-only square below the point where the nav starts to crowd; the
     hit target stays 44×44 so it is still easy to find and tap. */
  @media (max-width: 899px) {
    .theme {
      width: 44px;
      min-width: 44px;
      padding: 0;
      gap: 0;
    }
  }

  @media (min-width: 900px) {
    .theme-label {
      display: inline;
    }
  }

  @media (max-width: 767px) {
    .links,
    .desk-cta {
      display: none;
    }

    .toggle {
      display: inline-flex;
    }
  }
</style>
