<script lang="ts">
  import FrameworkTabs from './FrameworkTabs.svelte';
  import { reveal } from '$lib/reveal';
  import type { QuickstartSample } from '$lib/quickstart-samples';

  let { samples }: { samples: ReadonlyArray<QuickstartSample & { html: string }> } = $props();

  const frameworkKeys = new Set(['react', 'svelte', 'vue']);
  const frameworkSamples = $derived(samples.filter((sample) => frameworkKeys.has(sample.key)));
</script>

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
      {#each samples as sample, index (sample.key)}
        {#if sample.key === 'react'}
          <div class="block" use:reveal={index * 45}>
            <FrameworkTabs samples={frameworkSamples} />
          </div>
        {:else if !frameworkKeys.has(sample.key)}
          <div class="block" use:reveal={index * 45}>
            {@html sample.html}
          </div>
        {/if}
      {/each}
    </div>

    <p class="note">
      Every sample is TypeScript. React uses <code>.tsx</code> for JSX; Svelte and Vue use
      <code>&lt;script lang="ts"&gt;</code>. Adapted from the README and apps/example; hooks,
      crons, telemetry and dashboard live there.
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

  .note {
    margin-top: 18px;
    color: var(--muted);
    font-size: var(--text-xs);
  }
</style>
