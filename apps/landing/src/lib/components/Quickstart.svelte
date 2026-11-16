<script lang="ts">
  import { siReact, siSvelte, siTypescript, siVuedotjs } from 'simple-icons';
  import { onDestroy, tick } from 'svelte';
  import { reveal } from '$lib/reveal';
  import { quickstartGroups } from '$lib/quickstart-samples';
  import type { QuickstartSample } from '$lib/quickstart-samples';

  type Sample = QuickstartSample & { html: string };

  let { samples }: { samples: ReadonlyArray<Sample> } = $props();

  let active = $state('collections');
  let expanded = $state(false);
  let copied = $state(false);
  let copyTimer: number | undefined;
  let dialogElement = $state<HTMLDialogElement>();
  let editorScroll = $state<HTMLDivElement>();
  let pointerOnBackdrop = false;

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

    const dialog = dialogElement;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    requestAnimationFrame(() => editorScroll?.focus());
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
    if (event.key === 'ArrowDown') {
      nextIndex = index + 1 < files.length ? index + 1 : undefined;
    }
    if (event.key === 'ArrowUp') {
      nextIndex = index > 0 ? index - 1 : undefined;
    }
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

    let copiedOk = true;

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
      copiedOk = document.execCommand('copy');
      fallback.remove();
    }

    if (!copiedOk) return;

    copied = true;
    clearCopyTimer();
    copyTimer = window.setTimeout(() => {
      copied = false;
      copyTimer = undefined;
    }, 1600);
  }

  async function focusExpand() {
    await tick();
    document.getElementById('explorer-expand')?.focus();
  }

  function closeExpanded() {
    if (dialogElement?.open) dialogElement.close();
    expanded = false;
    void focusExpand();
  }

  function onDialogClose() {
    expanded = false;
    void focusExpand();
  }

  function onDialogPointerDown(event: PointerEvent) {
    pointerOnBackdrop = event.target === dialogElement;
  }

  function onDialogClick(event: MouseEvent) {
    if (event.target === dialogElement && pointerOnBackdrop) closeExpanded();
    pointerOnBackdrop = false;
  }
</script>

{#snippet explorerPanel(file: Sample & { iconClass: string }, inDialog: boolean)}
  <div class="explorer-chrome">
    <div class="explorer-chrome__left">
      <span class="explorer-tab">
        <svg class="explorer-tab__icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
        </svg>
        Code Explorer
      </span>
    </div>

    <div class="explorer-actions">
      <button
        type="button"
        class="explorer-action"
        class:is-copied={copied}
        aria-label={`Copy ${file.label}`}
        title="Copy active file"
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
        aria-label={inDialog ? 'Close code explorer' : 'Expand code explorer'}
        aria-expanded={inDialog ? undefined : false}
        aria-haspopup={inDialog ? undefined : 'dialog'}
        aria-controls={inDialog ? undefined : 'explorer-body'}
        title={inDialog ? 'Close code explorer' : 'Expand code explorer'}
        onclick={() => {
          if (inDialog) closeExpanded();
          else expanded = true;
        }}
      >
        {#if inDialog}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
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
    <label class="mobile-picker">
      <span class="sr-only">Quickstart file</span>
      <select
        aria-label="Quickstart file"
        value={file.key}
        onchange={(event) => select(event.currentTarget.value)}
      >
        {#each groups as group (group.id)}
          <optgroup label={group.label}>
            {#each group.files as item (item.key)}
              <option value={item.key}>{item.label}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </label>

    <div class="explorer-tree" role="listbox" aria-label="Quickstart files">
      {#each groups as group (group.id)}
        <div class="tree-group" role="group" aria-labelledby={`explorer-group-${group.id}`}>
          <p id={`explorer-group-${group.id}`} class="tree-group__label" role="presentation">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
            </svg>
            {group.label}
          </p>

          {#each group.files as item (item.key)}
            <button
              id={fileId(item.key)}
              type="button"
              class="tree-file"
              role="option"
              aria-selected={file.key === item.key}
              tabindex={file.key === item.key ? 0 : -1}
              onclick={() => select(item.key)}
              onkeydown={(event) => onFileKeyDown(event, item.key)}
            >
              <span class="file-icon {item.iconClass}">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={iconFor(item.key).path} />
                </svg>
              </span>
              <span class="tree-file__name">{item.label}</span>
            </button>
          {/each}
        </div>
      {/each}
    </div>

    <div class="explorer-main">
      <div class="explorer-breadcrumb">
        <span>{activeGroup?.label ?? ''}</span>
        <span class="explorer-breadcrumb__sep" aria-hidden="true">/</span>
        <span class="explorer-breadcrumb__file">{file.label}</span>
      </div>

      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="editor-scroll scroll-fade"
        id="explorer-code"
        bind:this={editorScroll}
        tabindex="0"
        role="region"
        aria-label={`${file.label} code, scroll to read`}
      >
        <div class="code-block editor-code">{@html file.html}</div>
      </div>

      <div class="explorer-statusbar">
        <span class="explorer-statusbar__lang">{languageLabel(file.lang)}</span>
        <span class="explorer-statusbar__meta">
          <span>UTF-8</span>
          <span>LF</span>
          <span>Spaces: 2</span>
        </span>
      </div>
    </div>
  </div>
{/snippet}

<section id="quickstart" class="section">
  <div class="container">
    <div class="section-head" use:reveal>
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
            <div class="explorer-placeholder" aria-hidden="true"></div>
            <dialog
              class="explorer-dialog"
              bind:this={dialogElement}
              aria-label="Code explorer"
              onclose={onDialogClose}
              onpointerdown={onDialogPointerDown}
              onclick={onDialogClick}
            >
              {@render explorerPanel(activeFile, true)}
            </dialog>
          {:else}
            <div class="explorer" use:reveal={90} role="region" aria-label="Code explorer">
              {@render explorerPanel(activeFile, false)}
            </div>
          {/if}
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
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(10, 10, 10, 0.04);
  }

  .explorer-placeholder {
    height: calc(clamp(380px, 48vh, 460px) + 42px);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
  }

  .explorer-dialog {
    width: min(calc(100vw - 2 * clamp(12px, 2.4vw, 36px)), var(--container));
    height: fit-content;
    max-width: none;
    max-height: calc(100dvh - 2 * clamp(12px, 2.4vw, 36px));
    margin: auto;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    color: var(--fg);
    overflow: hidden;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.32);
  }

  .explorer-dialog[open] {
    display: flex;
    flex-direction: column;
  }

  .explorer-dialog:modal {
    overscroll-behavior: contain;
  }

  .explorer-dialog::backdrop {
    overflow: hidden;
    overscroll-behavior: contain;
    background: rgba(8, 8, 10, 0.42);
  }

  .explorer-dialog .explorer-body {
    flex: 0 0 auto;
    height: auto;
    min-height: 0;
  }

  .explorer-dialog .explorer-main {
    min-height: 0;
  }

  .explorer-dialog .editor-scroll {
    flex: 0 1 auto;
    max-height: calc(100dvh - 2 * clamp(12px, 2.4vw, 36px) - 94px);
  }

  .explorer-dialog .editor-code {
    height: auto;
    min-height: 0;
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
    width: 32px;
    height: 32px;
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
    height: clamp(380px, 48vh, 460px);
    min-height: 0;
  }

  .mobile-picker {
    display: none;
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
    min-height: 30px;
    padding: 0 8px 0 19px;
    border: 0;
    border-left: 2px solid transparent;
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

  .tree-file[aria-selected='true'] {
    border-left-color: var(--ink);
    background: color-mix(in srgb, var(--ink) 8%, transparent);
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

    .explorer,
    .explorer-body,
    .explorer-tree,
    .explorer-main,
    .editor-scroll,
    .editor-code {
      max-width: 100%;
      min-width: 0;
    }

    .explorer-tree {
      display: none;
    }

    .mobile-picker {
      display: flex;
      align-items: center;
      padding: 8px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }

    .mobile-picker select {
      width: 100%;
      min-height: 44px;
      padding: 0 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface);
      color: var(--ink);
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      cursor: pointer;
    }

    .mobile-picker select:focus-visible {
      outline: 2px solid var(--ink);
      outline-offset: 1px;
    }

    .editor-scroll {
      max-height: 440px;
      overflow-x: hidden;
    }

    .explorer-statusbar {
      padding-right: 52px;
    }

    .editor-code :global(pre) {
      display: block;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .explorer-dialog {
      width: calc(100vw - 24px);
      height: calc(100dvh - 24px);
      max-height: none;
    }

    .explorer-dialog .explorer-body {
      flex: 1 1 auto;
      height: auto;
      min-height: 0;
    }

    .explorer-placeholder {
      display: none;
    }

    .explorer-dialog .editor-scroll {
      max-height: none;
    }
  }

  @media (max-width: 820px) {
    .explorer-chrome {
      min-height: 44px;
    }

    .explorer-tab {
      height: 44px;
    }

    .explorer-action {
      width: 44px;
      height: 44px;
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
