import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  optimizeDeps: {
    exclude: ['@tanstack/svelte-query']
  }
})
