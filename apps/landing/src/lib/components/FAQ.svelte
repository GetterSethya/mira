<script lang="ts">
  const items = [
    {
      question: 'Who is Mira for?',
      answer:
        'A solo developer or small team shipping a TypeScript app with data, auth and uploads, who would rather run one server than rent a backend.'
    },
    {
      question: 'What does it replace?',
      answer:
        'The router, session handling and upload endpoint you would otherwise wire. Routes, auth and uploads follow from the collections; rules sit beside them.'
    },
    {
      question: 'Why Effect?',
      answer:
        'The server is built on Effect v4, so services, layers and errors are Effect types. Handlers return a Promise from .raw() or an Effect from .toEffect().'
    },
    {
      question: 'Do I need config files?',
      answer:
        'No files. Collections and architecture are TypeScript; runtime settings live in a _config table, and S3 credentials can come from env.'
    },
    {
      question: 'Is it ready for production?',
      answer:
        'Not yet. Early pre-alpha: APIs can break between releases. Pin versions and read the release notes.'
    }
  ];
</script>

<section id="faq" class="section">
  <div class="container layout">
    <div class="section-head">
      <p class="eyebrow">FAQ</p>
      <h2>What to know before you install.</h2>
    </div>

    <div class="list">
      {#each items as item}
        <details>
          <summary>{item.question}</summary>
          <p>{item.answer}</p>
        </details>
      {/each}
    </div>
  </div>
</section>

<style>
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 0.75fr) minmax(0, 1.25fr);
    gap: clamp(32px, 5vw, 72px);
    align-items: start;
  }

  .list {
    border-top: 1px solid var(--border);
  }

  details {
    border-bottom: 1px solid var(--border);
  }

  summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    min-height: 62px;
    padding: 15px 0;
    color: var(--fg);
    font-size: var(--text-base);
    list-style: none;
    cursor: pointer;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary::after {
    content: '+';
    color: var(--muted);
    font-size: 18px;
    line-height: 1;
    transition: transform var(--motion-fast) var(--ease);
  }

  details[open] summary::after {
    content: '−';
  }

  details p {
    max-width: 62ch;
    margin: 0 0 22px;
    color: var(--muted);
    font-size: var(--text-sm);
    line-height: 1.75;
  }

  @media (max-width: 767px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
