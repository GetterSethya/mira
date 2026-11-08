<footer class="footer">
  <div class="container">
    <div class="top">
      <div class="brand">
        <a class="wordmark" href="#top">mira</a>
        <p>Collections in, REST out. One TypeScript process on Effect v4.</p>
      </div>

      <nav class="cols" aria-label="Footer">
        <div class="col">
          <h3>Product</h3>
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
        </div>
        <div class="col">
          <h3>Learn</h3>
          <a href="#quickstart">Quickstart</a>
          <a href="#faq">FAQ</a>
          <a href="https://github.com/GetterSethya/mira" target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </nav>
    </div>

    <div class="bottom">
      <span>© 2026 Mira</span>
      <span>Built with SvelteKit</span>
    </div>
  </div>
</footer>

<style>
  .footer {
    padding-block: 56px 28px;
    border-top: 1px solid var(--border);
    background: var(--surface);
    transition:
      background-color var(--motion-base) var(--ease),
      border-color var(--motion-base) var(--ease);
  }

  .top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 48px;
    flex-wrap: wrap;
  }

  .brand p {
    max-width: 34ch;
    margin-top: 12px;
    color: var(--muted);
    font-size: var(--text-sm);
  }

  .cols {
    display: flex;
    gap: 64px;
  }

  .col {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  h3 {
    margin-bottom: 2px;
    color: var(--muted);
    font-size: var(--text-2xs);
    font-weight: 500;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  .col a {
    color: var(--fg);
    font-size: var(--text-sm);
    text-decoration: none;
  }

  .col a:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-top: 48px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: var(--text-xs);
    flex-wrap: wrap;
  }

  @media (max-width: 599px) {
    .cols {
      gap: 40px;
    }
  }
</style>
