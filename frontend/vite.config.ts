import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `npm run dev` proxies the API to the demo server (tools/demo/server.py) or to NETDASH_API, e.g. https://192.168.1.1:8098
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', assetsDir: 'assets', sourcemap: false, chunkSizeWarningLimit: 800 },
  server: {
    proxy: { '/api': { target: process.env.NETDASH_API || 'http://127.0.0.1:8090', changeOrigin: true, secure: false } },
  },
})
