import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

// Cloudflare Rocket Loader 会改写 type="module" 并延迟执行；SPA 不需要它。
// data-cfasync="false" 让 Rocket Loader 跳过入口脚本，避免边缘改写导致白屏。
const rocketLoaderOptOut: Plugin = {
  name: 'antifieldcloud-rocket-loader-opt-out',
  enforce: 'post',
  transformIndexHtml(html) {
    return html.replace(/<script type="module"/g, '<script data-cfasync="false" type="module"')
  },
}

export default defineConfig({
  root,
  plugins: [react(), rocketLoaderOptOut],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/healthz': 'http://127.0.0.1:3000',
    },
  },
})
