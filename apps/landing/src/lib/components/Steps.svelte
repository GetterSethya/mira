<script lang="ts">
  import { reveal } from '$lib/reveal';

  const steps = [
    {
      index: '01',
      title: 'Write the collections',
      body: 'Base, auth and view collections, built with Field helpers. Relations, files and indexes live in the same module.'
    },
    {
      index: '02',
      title: 'Build the app',
      body: 'Mira.builder() requires platform, database, storage and collections; rules, crons, telemetry and CORS are optional. A missing step fails at compile time.'
    },
    {
      index: '03',
      title: 'Start the server',
      body: 'First boot seeds _config, generates the JWT secret, runs migrations and binds 8080 or the next free port. app.serve({ port }) overrides it.'
    }
  ];
</script>

<section id="how-it-works" class="section">
  <div class="container">
    <div class="section-head" use:reveal>
      <p class="eyebrow">How it works</p>
      <h2>From collections to a listening server.</h2>
    </div>

    <ol class="steps">
      {#each steps as step, index}
        <li use:reveal={index * 65}>
          <span class="num">{step.index}</span>
          <h3>{step.title}</h3>
          <p>{step.body}</p>
        </li>
      {/each}
    </ol>
  </div>
</section>

<style>
  .steps {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: clamp(24px, 3.5vw, 48px);
    margin-top: clamp(36px, 4.5vw, 56px);
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 20px;
    border-top: 1px solid var(--ink);
  }

  .num {
    color: var(--muted);
    font-size: var(--text-2xs);
    letter-spacing: 0.14em;
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

  @media (max-width: 767px) {
    .steps {
      grid-template-columns: minmax(0, 1fr);
      gap: 28px;
    }
  }
</style>
