<script lang="ts">
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';

  let visible = $state(false);

  function scrollToTop() {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  }

  onMount(() => {
    const onScroll = () => {
      visible = window.scrollY > 520;
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  });
</script>

{#if visible}
  <button
    class="scroll-top"
    type="button"
    aria-label="Scroll to top"
    title="Scroll to top"
    onclick={scrollToTop}
    transition:fade={{ duration: 140 }}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  </button>
{/if}

<style>
  .scroll-top {
    position: fixed;
    right: max(16px, env(safe-area-inset-right));
    bottom: max(16px, env(safe-area-inset-bottom));
    z-index: 70;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--ink);
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--ease),
      border-color var(--motion-fast) var(--ease);
  }

  .scroll-top:hover {
    border-color: var(--ink);
    background: var(--bg);
  }

  .scroll-top:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 3px;
  }

  svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
