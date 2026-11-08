<script lang="ts">
  import { toggleTheme } from '$lib/theme';
</script>

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
</button>

<style>
  .theme {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--nav-fg, currentColor);
    line-height: 1;
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--ease),
      color var(--motion-fast) var(--ease);
  }

  .theme:hover {
    background: var(--nav-chip-bg-hover, color-mix(in srgb, currentColor 10%, transparent));
  }

  .theme:active {
    background: color-mix(in srgb, currentColor 14%, transparent);
  }

  .theme:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }

  .icon {
    width: 17px;
    height: 17px;
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

</style>
