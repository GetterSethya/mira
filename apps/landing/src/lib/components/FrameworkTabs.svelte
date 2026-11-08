<script lang="ts">
  import { siReact, siSvelte, siVuedotjs } from 'simple-icons';
  import type { QuickstartSample } from '$lib/quickstart-samples';

  let {
    samples
  }: { samples: ReadonlyArray<QuickstartSample & { html: string }> } = $props();

  let active = $state('react');

  function iconFor(key: string) {
    if (key === 'react') return siReact;
    if (key === 'svelte') return siSvelte;
    return siVuedotjs;
  }

  const tabs = $derived(
    samples.map((sample) => ({
      key: sample.key,
      label: sample.key === 'react' ? 'React' : sample.key === 'svelte' ? 'Svelte' : 'Vue',
      icon: iconFor(sample.key)
    }))
  );

  $effect(() => {
    if (!samples.some((sample) => sample.key === active)) {
      active = samples[0]?.key ?? '';
    }
  });

  function select(key: string) {
    active = key;
  }

  function onKeyDown(event: KeyboardEvent, index: number) {
    let nextIndex: number | undefined;

    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();
    const next = tabs[nextIndex];
    if (!next) return;
    active = next.key;
    document.getElementById(`framework-tab-${next.key}`)?.focus();
  }
</script>

<div class="framework-tabs">
  <div class="tab-list" role="tablist" aria-label="Framework">
    {#each tabs as tab, index}
      <button
        id={`framework-tab-${tab.key}`}
        type="button"
        role="tab"
        aria-selected={active === tab.key}
        aria-controls={`framework-panel-${tab.key}`}
        tabindex={active === tab.key ? 0 : -1}
        onclick={() => select(tab.key)}
        onkeydown={(event) => onKeyDown(event, index)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={tab.icon.path} /></svg>
        {tab.label}
      </button>
    {/each}
  </div>

  {#each samples as sample}
    <div
      id={`framework-panel-${sample.key}`}
      role="tabpanel"
      aria-labelledby={`framework-tab-${sample.key}`}
      hidden={active !== sample.key}
    >
      {@html sample.html}
    </div>
  {/each}
</div>

<style>
  .framework-tabs {
    min-width: 0;
  }

  .tab-list {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 8px;
  }

  button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
  }

  button svg {
    width: 14px;
    height: 14px;
    fill: currentColor;
  }

  button:hover {
    color: var(--ink);
    border-color: var(--border-strong);
  }

  button[aria-selected='true'] {
    background: var(--ink);
    border-color: var(--ink);
    color: var(--bg);
  }

  button:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 2px;
  }

  [role='tabpanel'][hidden] {
    display: none;
  }
</style>
