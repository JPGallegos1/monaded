import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

import { fileURLToPath } from 'node:url'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    // Local same-origin /api → api Worker (mirrors production web→API proxy).
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, '') || '/',
      },
    },
  },
  plugins: [
    // Mermaid is rendered client-side only; resolve it to a stub in the SSR (Worker) build.
    {
      name: 'mermaid-ssr-stub',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'mermaid' && this.environment?.name === 'ssr') {
          return fileURLToPath(new URL('./src/lib/mermaid-ssr-stub.ts', import.meta.url))
        }
      },
    },
    devtools(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
