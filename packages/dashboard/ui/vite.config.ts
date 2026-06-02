import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const backendPort = process.env.MIRA_PORT || 8080

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  optimizeDeps: {
    exclude: ['@tanstack/svelte-query']
  },
  server: {
    proxy: {
      '/_dashboard/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
})
