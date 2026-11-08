<script lang="ts">
  import CodeBlock from './CodeBlock.svelte';
  import type { QuickstartSample } from '$lib/quickstart-samples';

  let { samples }: { samples: ReadonlyArray<QuickstartSample & { html: string }> } = $props();
</script>

<section id="quickstart" class="section">
  <div class="container">
    <div class="section-head">
      <p class="eyebrow">Seven files</p>
      <h2>The server, from collection to curl.</h2>
      <p class="lede">
        Two collections, a SQL view, rules, the server, a hook, a client, and the calls they
        answer.
      </p>
    </div>

    <div class="blocks">
      {#each samples as sample (sample.key)}
        <CodeBlock label={sample.label} code={sample.code} html={sample.html} />
      {/each}
    </div>

    <p class="note">
      Adapted from the README and apps/example; hooks, crons, telemetry and dashboard live
      there.
    </p>
  </div>
</section>

<style>
  .blocks {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
    margin-top: clamp(32px, 4vw, 48px);
  }

  .note {
    margin-top: 18px;
    color: var(--muted);
    font-size: var(--text-xs);
  }
</style>
