import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  // @prove.cash/sdk is a symlink to ../sdk, which keeps its own copy of viem to build and test
  // against. Without this the bundle ships viem twice.
  resolve: { dedupe: ['viem', '@msgboard/sdk'] },
})
