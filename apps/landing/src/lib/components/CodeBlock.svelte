<script lang="ts">
  let copyState = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;

  let { label, code, html }: { label: string; code: string; html?: string } = $props();

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const field = document.createElement('textarea');
      field.value = code;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }

    copyState = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => (copyState = false), 1600);
  }
</script>

<div class="block">
  <div class="bar">
    <span class="label">{label}</span>
    <button type="button" class="copy" onclick={copy} aria-label="Copy the {label} example">
      {copyState ? 'copied' : 'copy'}
    </button>
  </div>
  {#if html}
    {@html html}
  {:else}
    <pre><code>{code}</code></pre>
  {/if}
</div>

<style>
  .block {
    display: flex;
    flex-direction: column;
    min-width: 0;
    border: 1px solid var(--code-line);
    border-radius: var(--radius-md);
    background: var(--code-bg);
    overflow: hidden;
    transition:
      background-color var(--motion-base) var(--ease),
      border-color var(--motion-base) var(--ease);
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 0 12px 0 16px;
    min-height: 40px;
    border-bottom: 1px solid var(--code-line);
  }

  .label {
    color: color-mix(in srgb, var(--code-fg) 58%, transparent);
    font-size: var(--text-2xs);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .copy {
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid var(--code-line);
    border-radius: 4px;
    background: transparent;
    color: color-mix(in srgb, var(--code-fg) 55%, transparent);
    font-size: var(--text-2xs);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    cursor: pointer;
    transition:
      border-color var(--motion-fast) var(--ease),
      color var(--motion-fast) var(--ease);
  }

  .copy:hover {
    border-color: #52525b;
    color: var(--code-fg);
  }

  .copy:focus-visible {
    outline: 2px solid var(--code-fg);
    outline-offset: 2px;
  }

  pre {
    margin: 0;
    padding: 18px 16px 20px;
    overflow-x: auto;
    color: var(--code-fg);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: 1.75;
    tab-size: 2;
  }

  code {
    font-family: inherit;
  }

  .block :global(pre.shiki) {
    margin: 0;
    padding: 18px 16px 20px;
    overflow-x: auto;
    background: transparent !important;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: 1.75;
    tab-size: 2;
  }

  .block :global(pre.shiki code) {
    font-family: inherit;
  }
</style>
