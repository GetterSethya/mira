<script lang="ts">
  import Nav from '$lib/components/Nav.svelte';
  import NoticeBar from '$lib/components/NoticeBar.svelte';
  import Hero from '$lib/components/Hero.svelte';
  import Features from '$lib/components/Features.svelte';
  import Steps from '$lib/components/Steps.svelte';
  import Quickstart from '$lib/components/Quickstart.svelte';
  import FAQ from '$lib/components/FAQ.svelte';
  import CTABand from '$lib/components/CTABand.svelte';
  import Footer from '$lib/components/Footer.svelte';

  let { data } = $props();
</script>

<svelte:head>
  <title>Mira — a backend you define and run</title>
  <meta
    name="description"
    content="Collection definitions in TypeScript become a REST API with auth, rules, uploads, cursor pagination and a typed client. Self-hosted, on Effect v4."
  />
  <meta property="og:title" content="Mira — a backend you define and run" />
  <meta
    property="og:description"
    content="Collections in TypeScript. REST API, auth, uploads and rules out. One server you run, on Effect v4."
  />
  <meta property="og:type" content="website" />
</svelte:head>

<a class="skip" href="#main">Skip to content</a>

<div class="top-stack">
  <NoticeBar />
  <Nav />
</div>

<main id="main">
  <Hero />
  <Features />
  <Steps />
  <Quickstart samples={data.samples} />
  <FAQ />
  <CTABand />
</main>

<Footer />

<style>
  .top-stack {
    position: sticky;
    top: 0;
    z-index: 40;
  }
</style>
