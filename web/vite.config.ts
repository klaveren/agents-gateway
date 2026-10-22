import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

/**
 * No dev, o Vite serve a tela e repassa `/v1` ao gateway — mesma origem, sem CORS para configurar.
 * `GATEWAY_URL` aponta para outro gateway; o padrão é o local.
 */
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: { '/v1': { target: process.env.GATEWAY_URL ?? 'http://127.0.0.1:3100' } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'jsdom' },
})
