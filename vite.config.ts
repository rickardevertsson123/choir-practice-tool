import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // AudioWorklet modules must be served as real JS files in production.
  // If Vite inlines them as data: URLs, Chrome may fail to load them via audioWorklet.addModule().
  build: {
    assetsInlineLimit: 0,
  },
})