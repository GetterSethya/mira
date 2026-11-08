<section class="cta">
  <div class="container inner">
    <div class="copy">
      <h2>Start with one collection.</h2>
      <p>
        Install the packages, add a collection definition and its rules, then call app.serve().
        First boot seeds _config and runs migrations.
      </p>
    </div>
    <a class="btn btn-invert" href="#quickstart">Open the quickstart</a>
  </div>
</section>

<style>
  .cta {
    border-top: 1px solid var(--border-strong);
    background: var(--cta-bg);
    color: var(--cta-fg);
    transition:
      background-color var(--motion-base) var(--ease),
      border-color var(--motion-base) var(--ease);
  }

  .inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 40px;
    padding-block: clamp(56px, 8vw, 96px);
    flex-wrap: wrap;
  }

  h2 {
    max-width: 18ch;
    color: var(--cta-fg);
    font-size: clamp(28px, 4vw, 44px);
    letter-spacing: -0.035em;
  }

  p {
    max-width: 46ch;
    margin-top: 16px;
    color: var(--cta-muted);
    font-size: var(--text-sm);
    line-height: 1.75;
  }

  @media (max-width: 639px) {
    .inner {
      align-items: flex-start;
      flex-direction: column;
      gap: 28px;
    }

    .btn {
      width: 100%;
    }
  }
</style>
