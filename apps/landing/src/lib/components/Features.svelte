<script lang="ts">
  import { reveal } from '$lib/reveal';

  const features = [
    {
      index: '01',
      domain: 'collections',
      title: 'Collections in TypeScript',
      body: 'Fields, relations, file fields and auth collections live in one module. Client and server import it, so the types match.'
    },
    {
      index: '02',
      domain: 'rules',
      title: 'Rules on every request',
      body: 'Rules compile to a SQL WHERE clause and run on every call. A missing rule denies ordinary callers; plugin admin collections are exempt.'
    },
    {
      index: '03',
      domain: 'rest api',
      title: 'Routes you do not write',
      body: 'CRUD, uploads, JSON filters, sort, select, expand and seqId cursor pagination. No route files to keep in sync.'
    },
    {
      index: '04',
      domain: 'client',
      title: 'A typed client',
      body: 'createMiraClient() reads the same definitions, so a renamed field fails at compile time. Handlers return a Promise from .raw() or an Effect from .toEffect().'
    },
    {
      index: '05',
      domain: 'dashboard',
      title: 'An optional dashboard',
      body: 'The plugin mounts /_dashboard/: a record browser, config, crons and Connect snippets. Log and span viewers need makeSqliteTelemetryLayer.'
    },
    {
      index: '06',
      domain: 'storage',
      title: 'SQLite, or your bucket',
      body: 'The builder ships SQLite and local-disk presets; SQLite is the only database backend. An S3-compatible bucket drops in without touching a collection.'
    }
  ];
</script>

<section id="features" class="section">
  <div class="container">
    <div class="section-head" use:reveal>
      <p class="eyebrow">What it replaces</p>
      <h2>Write collections in TypeScript; the API follows.</h2>
      <p class="lede">
        For a solo developer or small team: each collection yields its table, routes and
        types, replacing the router, auth and upload code you would write.
      </p>
    </div>

    <div class="grid">
      {#each features as feature, index}
        <article class="card" use:reveal={index * 55}>
          <div class="meta">
            <span>{feature.index}</span>
            <span>{feature.domain}</span>
          </div>
          <h3>{feature.title}</h3>
          <p>{feature.body}</p>
        </article>
      {/each}
    </div>
  </div>
</section>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    margin-top: clamp(32px, 4vw, 48px);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--border);
    overflow: hidden;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 26px 24px 32px;
    background: var(--surface);
    transition: background-color var(--motion-base) var(--ease);
  }

  .card:hover {
    background: var(--bg);
  }

  .meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
    color: var(--muted);
    font-size: var(--text-2xs);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .meta span:last-child {
    color: var(--ink);
  }

  h3 {
    font-size: var(--text-lg);
    letter-spacing: -0.02em;
    line-height: 1.25;
  }

  p {
    color: var(--muted);
    font-size: var(--text-sm);
    line-height: 1.7;
  }

  @media (max-width: 899px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 599px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .card {
      padding: 22px 20px 26px;
    }
  }
</style>
