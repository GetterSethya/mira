<script lang="ts">
  import { onMount } from 'svelte';
  import { mountDither } from '$lib/dither';

  let canvas: HTMLCanvasElement | undefined = undefined;

  onMount(() => {
    if (!canvas) return;
    return mountDither(canvas);
  });
</script>

<canvas bind:this={canvas} aria-hidden="true"></canvas>

<style>
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    filter: var(--hero-canvas-filter, invert(1));
    transition: filter var(--motion-base) var(--ease);
  }
</style>
