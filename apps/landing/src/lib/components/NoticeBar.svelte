<script lang="ts">
  import { onMount } from 'svelte';

  const STORAGE_KEY = 'mira-notice-prealpha-v1';

  let dismissed = $state(false);
  let height = $state(0);

  $effect(() => {
    document.documentElement.style.setProperty(
      '--notice-height',
      dismissed ? '0px' : `${height}px`
    );
  });

  onMount(() => {
    try {
      if (sessionStorage.getItem(STORAGE_KEY) === '1') dismissed = true;
    } catch {
      // Storage may be unavailable; the bar still dismisses for this session.
    }
  });

  function dismiss() {
    dismissed = true;

    try {
      sessionStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // Ignore storage failures; the in-memory state still hides the bar.
    }

    document.documentElement.dataset.announcement = 'dismissed';
  }
</script>

{#if !dismissed}
  <aside class="notice" aria-label="Pre-alpha notice" bind:clientHeight={height}>
    <div class="container inner">
      <p>mira is early pre-alpha. Expect breaking changes.</p>
      <button
        type="button"
        class="close"
        onclick={dismiss}
        aria-label="Dismiss pre-alpha notice"
        title="Dismiss"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 3l10 10M13 3L3 13" />
        </svg>
      </button>
    </div>
  </aside>
{/if}

<style>
  .notice {
    background: var(--ink);
    color: var(--bg);
    transition:
      background-color var(--motion-base) var(--ease),
      color var(--motion-base) var(--ease);
  }

  .inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 40px;
    padding-block: 4px;
  }

  p {
    margin: 0;
    font-size: var(--text-xs);
    letter-spacing: 0.02em;
    line-height: 1.5;
  }

  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--ease),
      border-color var(--motion-fast) var(--ease);
  }

  .close:hover {
    border-color: currentColor;
    background: color-mix(in srgb, currentColor 10%, transparent);
  }

  .close:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }

  .close svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }

  :global(html[data-announcement='dismissed']) .notice {
    display: none;
  }

  @media (max-width: 599px) {
    .inner {
      align-items: flex-start;
    }

    p {
      padding-block: 8px;
    }

    .close {
      width: 40px;
      height: 40px;
    }
  }
</style>
