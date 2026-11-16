<script lang="ts">
  import { siReact, siSvelte, siTypescript, siVuedotjs } from 'simple-icons';
  import { onDestroy } from 'svelte';
  import { reveal } from '$lib/reveal';
  import { quickstartGroups } from '$lib/quickstart-samples';
  import type { QuickstartSample } from '$lib/quickstart-samples';

  type Sample = QuickstartSample & { html: string };

  let { samples }: { samples: ReadonlyArray<Sample> } = $props();

  let active = $state('collections');
  let expanded = $state(false);
  let copied = $state(false);
  let copyTimer: number | undefined;
  let explorerElement = $state<HTMLDivElement>();
  let editorScroll = $state<HTMLDivElement>();

  const installSample = $derived(samples.find((sample) => sample.key === 'install'));
  const restSample = $derived(samples.find((sample) => sample.key === 'rest'));

  const languageLabels: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TSX',
    svelte: 'Svelte',
    vue: 'Vue',
    bash: 'Shell',
    json: 'JSON'
  };

  function languageLabel(lang: string) {
    return languageLabels[lang] ?? lang;
  }

  function iconFor(key: string) {
    if (key === 'react') return siReact;
    if (key === 'svelte') return siSvelte;
    if (key === 'vue') return siVuedotjs;
    return siTypescript;
  }

  function iconClassFor(key: string) {
    if (key === 'react') return 'file-icon--tsx';
    if (key === 'svelte') return 'file-icon--svelte';
    if (key === 'vue') return 'file-icon--vue';
    return 'file-icon--ts';
  }

  function fileId(key: string) {
    return `explorer-file-${key}`;
  }

  const groups = $derived(
    quickstartGroups.map((group) => ({
      id: group.id,
      label: group.label,
      files: group.keys.flatMap((key) => {
        const sample = samples.find((item) => item.key === key);
        if (!sample) return [];
        return [{ ...sample, iconClass: iconClassFor(sample.key) }];
      })
    }))
  );

  const files = $derived(groups.flatMap((group) => group.files));
  const activeFile = $derived(files.find((file) => file.key === active));
  const activeGroup = $derived(
    groups.find((group) => group.files.some((file) => file.key === active))
  );

  $effect(() => {
    if (files.length === 0) {
      if (active !== '') active = '';
      return;
    }

    if (!files.some((file) => file.key === active)) {
      active = files[0]?.key ?? '';
    }
  });

  $effect(() => {
    if (!expanded) return;

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    queueMicrotask(() => explorerElement?.focus());

    return () => {
      document.body.style.overflow = previous;
    };
  });

  onDestroy(() => {
    if (copyTimer !== undefined) window.clearTimeout(copyTimer);
  });

  function clearCopyTimer() {
    if (copyTimer === undefined) return;
    window.clearTimeout(copyTimer);
    copyTimer = undefined;
  }

  function select(key: string) {
    active = key;
    copied = false;
    clearCopyTimer();
    requestAnimationFrame(() => editorScroll?.scrollTo({ top: 0, left: 0 }));
  }

  function onFileKeyDown(event: KeyboardEvent, key: string) {
    const index = files.findIndex((file) => file.key === key);
    if (index < 0) return;

    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') nextIndex = (index + 1) % files.length;
    if (event.key === 'ArrowUp') nextIndex = (index - 1 + files.length) % files.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = files.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();

    const next = files[nextIndex];
    if (!next) return;

    select(next.key);
    document.getElementById(fileId(next.key))?.focus();
  }

  async function copyActive() {
    const sample = activeFile;
    if (!sample) return;

    try {
      await navigator.clipboard.writeText(sample.code);
    } catch {
      const fallback = document.createElement('textarea');
      fallback.value = sample.code;
      fallback.setAttribute('readonly', '');
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      fallback.remove();
    }

    copied = true;
    clearCopyTimer();
    copyTimer = window.setTimeout(() => {
      copied = false;
      copyTimer = undefined;
    }, 1600);
  }

  function closeExpanded() {
    expanded = false;
    queueMicrotask(() => document.getElementById('explorer-expand')?.focus());
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (!expanded) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      closeExpanded();
      return;
    }

    if (event.key !== 'Tab' || !explorerElement) return;

    const focusables = Array.from(
      explorerElement.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.hasAttribute('disabled') &&
        element.getClientRects().length > 0
    );

    const first = focusables[0];
    const last = focusables.at(-1);
    if (!first || !last) {
      event.preventDefault();
      explorerElement.focus();
      return;
    }

    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === explorerElement)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (current === last || current === explorerElement)) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<section id="quickstart" class="section">
  <div class="container">
    <div class="section-head" use:reveal>
      <p class="eyebrow">Install to client</p>
      <h2>The server, then the client.</h2>
      <p class="lede">
        Install the packages, define collections, serve them, then call the API from React,
        Svelte, or Vue through the TanStack adapter.
      </p>
      <dl class="packages" aria-label="Package roles">
        <div>
          <dt>@gettersethya/mira</dt>
          <dd>Server: builder, routes, auth, rules, storage.</dd>
        </div>
        <div>
          <dt>@gettersethya/mira-collection</dt>
          <dd>Collection and field definitions.</dd>
        </div>
        <div>
          <dt>@gettersethya/mira-client</dt>
          <dd>Typed client SDK for the browser or server.</dd>
        </div>
        <div>
          <dt>effect@^4</dt>
          <dd>Peer dependency of the server and client packages.</dd>
        </div>
      </dl>
    </div>

    <div class="blocks">
      {#if installSample}
        <div class="block" use:reveal={20}>
          {@html installSample.html}
        </div>
      {/if}

      {#if activeFile}
        <div class="block block--explorer">
          {#if expanded}
            <button
              class="explorer-backdrop"
              type="button"
              tabindex="-1"
              aria-label="Close expanded code explorer"
              onclick={closeExpanded}
            ></button>
          {/if}

          <div
            class="explorer"
            class:is-expanded={expanded}
            use:reveal={90}
            bind:this={explorerElement}
            tabindex="-1"
            role={expanded ? 'dialog' : 'region'}
            aria-modal={expanded ? 'true' : undefined}
            aria-label="Code explorer"
          >
            <div class="explorer-chrome">
              <div class="explorer-chrome__left">
                <span class="explorer-tab">
                  <svg class="explorer-tab__icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
                  </svg>
                  Code Explorer
                </span>
                <span class="explorer-title">mira-quickstart</span>
              </div>

              <div class="explorer-actions">
                <button
                  type="button"
                  class="explorer-action"
                  class:is-copied={copied}
                  aria-label={copied ? 'Copied to clipboard' : `Copy ${activeFile.label}`}
                  title={copied ? 'Copied' : 'Copy active file'}
                  onclick={copyActive}
                >
                  {#if copied}
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                  {:else}
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="8" y="8" width="11" height="11" rx="1.5" />
                      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
                    </svg>
                  {/if}
                </button>

                <button
                  id="explorer-expand"
                  type="button"
                  class="explorer-action"
                  aria-label={expanded ? 'Collapse code explorer' : 'Expand code explorer'}
                  aria-expanded={expanded}
                  aria-controls="explorer-body"
                  title={expanded ? 'Collapse code explorer' : 'Expand code explorer'}
                  onclick={() => (expanded = !expanded)}
                >
                  {#if expanded}
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M8 21v-3a2 2 0 0 0-2-2H3M16 21v-3a2 2 0 0 1 2-2h3" />
                    </svg>
                  {:else}
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
                    </svg>
                  {/if}
                </button>
              </div>

              <span class="sr-only" role="status" aria-live="polite">
                {copied ? 'Copied to clipboard' : ''}
              </span>
            </div>

            <div class="explorer-body" id="explorer-body">
              <nav class="explorer-tree" aria-label="Quickstart files">
                {#each groups as group (group.id)}
                  <div class="tree-group">
                    <p class="tree-group__label">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
                      </svg>
                      {group.label}
                    </p>

                    {#each group.files as file (file.key)}
                      <button
                        id={fileId(file.key)}
                        type="button"
                        class="tree-file"
                        aria-current={active === file.key ? 'true' : undefined}
                        tabindex={active === file.key ? 0 : -1}
                        onclick={() => select(file.key)}
                        onkeydown={(event) => onFileKeyDown(event, file.key)}
                      >
                        <span class="file-icon {file.iconClass}">
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d={iconFor(file.key).path} />
                          </svg>
                        </span>
                        <span class="tree-file__name">{file.label}</span>
                      </button>
                    {/each}
                  </div>
                {/each}
              </nav>

              <div class="explorer-main">
                <div class="explorer-breadcrumb">
                  <span>{activeGroup?.label ?? ''}</span>
                  <span class="explorer-breadcrumb__sep" aria-hidden="true">/</span>
                  <span class="explorer-breadcrumb__file">{activeFile.label}</span>
                </div>

                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <div
                  class="editor-scroll"
                  bind:this={editorScroll}
                  tabindex="0"
                  role="region"
                  aria-label={`${activeFile.label} code, scroll to read`}
                >
                  <div class="code-block editor-code">{@html activeFile.html}</div>
                </div>

                <div class="explorer-statusbar">
                  <span class="explorer-statusbar__lang">{languageLabel(activeFile.lang)}</span>
                  <span class="explorer-statusbar__meta">
                    <span>UTF-8</span>
                    <span>LF</span>
                    <span>Spaces: 2</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      {/if}

      {#if restSample}
        <div class="block" use:reveal={160}>
          {@html restSample.html}
        </div>
      {/if}
    </div>

    <p class="note">
      Install commands stay above the explorer. Every editor file is TypeScript, with
      <code>.tsx</code> for React JSX and <code>{'<script lang="ts">'}</code> in Svelte and Vue.
      The REST walkthrough below repeats the same operations with curl. Adapted from the README
      and apps/example, where hooks, crons, telemetry and the dashboard live.
    </p>
  </div>
</section>

<style>
  .packages {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 14px 28px;
    margin: clamp(24px, 3vw, 32px) 0 0;
    padding: 0;
  }

  .packages div {
    display: grid;
    gap: 3px;
  }

  .packages dt {
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .packages dd {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
    line-height: 1.6;
  }

  .blocks {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
    margin-top: clamp(32px, 4vw, 48px);
  }

  .block {
    min-width: 0;
  }

  .block :global(.code-block) {
    margin: 0;
  }

  .block--explorer {
    position: relative;
  }

  .explorer {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(10, 10, 10, 0.04);
  }

  .explorer.is-expanded {
    position: fixed;
    inset: clamp(12px, 2.4vw, 36px);
    z-index: 61;
    border-radius: var(--radius-md);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.32);
    background: var(--surface);
  }

  .explorer-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    padding: 0;
    border: 0;
    background: rgba(8, 8, 10, 0.42);
    cursor: pointer;
  }

  .explorer-backdrop:focus-visible {
    outline: 2px solid var(--bg);
    outline-offset: -4px;
  }

  .explorer-chrome {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 0 6px 0 0;
    border-bottom: 1px solid var(--border);
    background: var(--code-bg);
  }

  .explorer-chrome__left {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .explorer-tab {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 7px;
    height: 40px;
    padding: 0 14px;
    border-right: 1px solid var(--border);
    background: var(--surface);
    box-shadow: inset 0 2px 0 var(--ink);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
  }

  .explorer-tab__icon {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .explorer-title {
    min-width: 0;
    overflow: hidden;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .explorer-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
  }

  .explorer-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 28px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--ease),
      border-color var(--motion-fast) var(--ease),
      color var(--motion-fast) var(--ease);
  }

  .explorer-action svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .explorer-action:hover {
    border-color: var(--border);
    background: var(--surface);
    color: var(--ink);
  }

  .explorer-action.is-copied {
    color: var(--success);
  }

  .explorer-action:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }

  .explorer-body {
    display: grid;
    grid-template-columns: 208px minmax(0, 1fr);
    height: clamp(460px, 62vh, 640px);
    min-height: 0;
  }

  .explorer.is-expanded .explorer-body {
    flex: 1 1 auto;
    height: auto;
    min-height: 0;
  }

  .explorer-tree {
    min-height: 0;
    padding: 10px 6px 14px;
    overflow-x: hidden;
    overflow-y: auto;
    border-right: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 72%, var(--code-bg));
    scrollbar-width: thin;
    overscroll-behavior: contain;
  }

  .tree-group + .tree-group {
    margin-top: 12px;
  }

  .tree-group__label {
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 0 0 3px;
    padding: 2px 8px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.03em;
    line-height: 1.5;
    user-select: none;
  }

  .tree-group__label svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linejoin: round;
  }

  .tree-file {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 27px;
    padding: 0 8px 0 19px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1;
    text-align: left;
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--ease),
      color var(--motion-fast) var(--ease);
  }

  .tree-file:hover {
    background: color-mix(in srgb, var(--ink) 5%, transparent);
  }

  .tree-file[aria-current='true'] {
    background: color-mix(in srgb, var(--ink) 8%, transparent);
    box-shadow: inset 2px 0 0 var(--ink);
    color: var(--ink);
  }

  .tree-file:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: -1px;
  }

  .tree-file__name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-icon {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
  }

  .file-icon svg {
    width: 13px;
    height: 13px;
    fill: currentColor;
  }

  .file-icon--ts {
    color: #3178c6;
  }

  .file-icon--tsx {
    color: #61dafb;
  }

  .file-icon--svelte {
    color: #ff3e00;
  }

  .file-icon--vue {
    color: #41b883;
  }

  .explorer-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--code-bg);
  }

  .explorer-breadcrumb {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 0 12px;
    overflow: hidden;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: 1;
    white-space: nowrap;
  }

  .explorer-breadcrumb__sep {
    color: var(--border-strong);
  }

  .explorer-breadcrumb__file {
    overflow: hidden;
    color: var(--ink);
    text-overflow: ellipsis;
  }

  .editor-scroll {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    background: var(--code-bg);
    scrollbar-width: thin;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }

  .editor-scroll:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: -2px;
  }

  .editor-code {
    height: 100%;
    min-height: 100%;
    margin: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    overflow: visible;
  }

  .editor-code :global(.code-block) {
    margin: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    overflow: visible;
  }

  .editor-code :global(.code-block__bar) {
    display: none;
  }

  .editor-code :global(pre) {
    width: max-content;
    min-width: 100%;
    min-height: 100%;
    margin: 0;
    padding: 14px 16px 18px;
    border: 0;
    border-radius: 0;
    background: transparent !important;
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.72;
    tab-size: 2;
    white-space: pre;
    overflow: visible;
    overflow-wrap: normal;
    word-break: normal;
  }

  .editor-code :global(pre.shiki) {
    background: transparent !important;
  }

  .editor-code :global(pre code) {
    font-family: inherit;
  }

  .explorer-statusbar {
    display: flex;
    flex: none;
    align-items: center;
    gap: 12px;
    min-height: 26px;
    padding: 0 12px;
    border-top: 1px solid var(--border);
    background: var(--surface);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.02em;
    line-height: 1;
  }

  .explorer-statusbar__lang {
    color: var(--ink);
  }

  .explorer-statusbar__meta {
    display: flex;
    gap: 12px;
    margin-left: auto;
  }

  .note {
    margin-top: 18px;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  @media (max-width: 820px) {
    .explorer-body {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
      height: auto;
    }

    .explorer-tree {
      display: flex;
      gap: 6px;
      padding: 8px;
      overflow-x: auto;
      overflow-y: hidden;
      border-right: 0;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }

    .tree-group {
      display: contents;
    }

    .tree-group__label {
      display: none;
    }

    .tree-file {
      flex: none;
      width: auto;
      min-height: 32px;
      padding: 0 10px;
      border: 1px solid var(--border);
      font-size: var(--text-2xs);
    }

    .tree-file[aria-current='true'] {
      border-color: var(--border-strong);
    }

    .editor-scroll {
      max-height: 440px;
    }

    .explorer.is-expanded .explorer-body {
      height: auto;
      min-height: 0;
    }

    .explorer.is-expanded .editor-scroll {
      max-height: none;
    }
  }

  @media (max-width: 520px) {
    .explorer-chrome {
      padding-right: 3px;
    }

    .explorer-tab {
      gap: 6px;
      padding: 0 10px;
    }

    .explorer-title {
      display: none;
    }

    .explorer-action {
      width: 28px;
    }

    .explorer-breadcrumb,
    .explorer-statusbar {
      padding: 0 9px;
    }

    .explorer-statusbar {
      font-size: var(--text-2xs);
    }

    .explorer-statusbar__meta {
      gap: 9px;
    }

    .editor-code :global(pre) {
      padding: 12px 12px 16px;
      font-size: 12px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .explorer-action,
    .tree-file {
      transition: none;
    }
  }
</style>
