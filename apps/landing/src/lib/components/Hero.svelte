<script lang="ts">
  import DitherCanvas from './DitherCanvas.svelte';
</script>

<section id="top" class="hero">
  <div class="art">
    <DitherCanvas />
  </div>

  <div class="container inner">
    <div class="copy">
      <p class="eyebrow">TypeScript on Effect v4</p>
      <h1>A backend you define and&nbsp;run.</h1>
      <p class="lede">
        Mira is a TypeScript backend you host: collections in code, and routes, auth,
        uploads and rules built from them.
      </p>
      <div class="actions">
        <a class="btn btn-primary" href="#quickstart">Open the quickstart</a>
        <a class="btn btn-secondary" href="#how-it-works">How it works</a>
      </div>
      <ul class="spec" aria-label="Core capabilities">
        <li>collections</li>
        <li>rules</li>
        <li>auth</li>
        <li>uploads</li>
        <li>dashboard</li>
      </ul>
    </div>
  </div>

  <div class="container meta">
    <span>fig. 01 — abstract dither field</span>
    <span>8×8 bayer · 1-bit</span>
  </div>
</section>

<style>
  .hero {
    position: relative;
    isolation: isolate;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: clamp(640px, 100svh, 1040px);
    margin-top: -64px;
    padding-top: 64px;
    overflow: hidden;
    background: var(--hero-bg);
    color: var(--hero-fg);
    transition:
      background-color var(--motion-base) var(--ease),
      color var(--motion-base) var(--ease);
  }

  .art {
    position: absolute;
    inset: 0;
    z-index: 0;
  }

  .art::after {
    content: '';
    position: absolute;
    inset: 0;
    background:
      linear-gradient(
        90deg,
        var(--hero-bg) 0%,
        rgb(var(--hero-veil) / 0.96) 20%,
        rgb(var(--hero-veil) / 0.82) 38%,
        rgb(var(--hero-veil) / 0.32) 60%,
        rgb(var(--hero-veil) / 0) 82%
      ),
      linear-gradient(
        180deg,
        rgb(var(--hero-veil) / 0.72) 0%,
        rgb(var(--hero-veil) / 0) 16%,
        rgb(var(--hero-veil) / 0) 72%,
        var(--hero-bg) 100%
      );
  }

  .inner {
    position: relative;
    z-index: 2;
    padding-block: clamp(72px, 10vw, 132px) clamp(120px, 16vw, 200px);
  }

  .copy {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 22px;
    max-width: 620px;
  }

  .eyebrow {
    color: var(--hero-muted);
  }

  h1 {
    max-width: 19ch;
    color: var(--hero-fg);
    font-size: clamp(40px, 5.6vw, 76px);
    letter-spacing: -0.045em;
  }

  .lede {
    max-width: 48ch;
    color: color-mix(in srgb, var(--hero-fg) 68%, transparent);
    font-size: var(--text-base);
    line-height: 1.7;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .actions .btn-secondary {
    border-color: color-mix(in srgb, var(--hero-fg) 32%, transparent);
    color: var(--hero-fg);
  }

  .actions .btn-secondary:hover {
    border-color: var(--hero-fg);
    background: color-mix(in srgb, var(--hero-fg) 6%, transparent);
  }

  .spec {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    margin-top: 6px;
    padding: 9px 13px;
    border: 1px solid var(--hero-line);
    border-radius: var(--radius-sm);
    background: var(--hero-bg);
    list-style: none;
    color: var(--hero-muted);
    font-size: var(--text-2xs);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .spec li + li::before {
    content: '/';
    margin: 0 10px;
    color: color-mix(in srgb, var(--hero-fg) 28%, transparent);
  }

  .meta {
    position: absolute;
    inset-inline: 0;
    bottom: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-block: 15px;
    border-top: 1px solid var(--hero-line);
    color: var(--hero-muted);
    font-size: var(--text-2xs);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    flex-wrap: wrap;
  }

  /* Solid strip behind the caption so the dither cannot wash it out. */
  .meta::before {
    content: '';
    position: absolute;
    inset-block: 0;
    left: 50%;
    z-index: -1;
    width: 100vw;
    background: var(--hero-bg);
    transform: translateX(-50%);
  }

  @media (max-width: 767px) {
    /* Narrow screens have no left-hand column to hide behind, so the veil has
       to run vertically across the whole copy block instead. */
    .art::after {
      background: linear-gradient(
        180deg,
        rgb(var(--hero-veil) / 0.82) 0%,
        rgb(var(--hero-veil) / 0.96) 14%,
        rgb(var(--hero-veil) / 0.96) 76%,
        rgb(var(--hero-veil) / 0.5) 88%,
        rgb(var(--hero-veil) / 0) 94%,
        var(--hero-bg) 100%
      );
    }

    .inner {
      padding-block: 72px 132px;
    }

    .meta {
      gap: 8px;
    }

    .meta span:first-child {
      display: none;
    }
  }
</style>
