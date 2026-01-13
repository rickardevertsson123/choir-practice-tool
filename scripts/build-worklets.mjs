import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'

await mkdir('public/worklets', { recursive: true })

await build({
  entryPoints: ['src/audio/worklets/pitchDetector.worklet.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: true,
  outfile: 'public/worklets/pitchDetector.worklet.js',
  logLevel: 'info',
})


