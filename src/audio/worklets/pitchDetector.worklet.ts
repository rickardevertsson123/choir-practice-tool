/// <reference path="./audioworklet-globals.d.ts" />
import { detectPitch } from '../pitchDetection'

type PitchMessage =
  | { type: 'pitch'; frequency: number | null; clarity: number; audioTimeSec: number; halfWindowSec: number; detectMs?: number }
  | { type: 'ready' }

type ControlMessage =
  | { type: 'config'; windowSize: number; analysisIntervalMs: number }
  | { type: 'hint'; targetMidi: number | null }

class PitchDetectorProcessor extends AudioWorkletProcessor {
  private windowSize = 4096
  private analysisIntervalMs = 50

  private ring = new Float32Array(this.windowSize)
  private window = new Float32Array(this.windowSize)
  private writeIdx = 0
  private filled = false

  private hopSamples = Math.max(1, Math.round(sampleRate * (this.analysisIntervalMs / 1000)))
  private samplesSinceLast = 0

  private targetMidi: number | null = null

  constructor(options?: AudioWorkletNodeOptions) {
    super()

    const po = options?.processorOptions as any
    if (po && typeof po.windowSize === 'number') this.windowSize = po.windowSize
    if (po && typeof po.analysisIntervalMs === 'number') this.analysisIntervalMs = po.analysisIntervalMs

    this.rebuildBuffers()

    this.port.onmessage = (ev: MessageEvent<ControlMessage>) => {
      const msg = ev.data
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'config') {
        if (typeof msg.windowSize === 'number' && msg.windowSize > 0) this.windowSize = msg.windowSize
        if (typeof msg.analysisIntervalMs === 'number' && msg.analysisIntervalMs > 0) this.analysisIntervalMs = msg.analysisIntervalMs
        this.rebuildBuffers()
      } else if (msg.type === 'hint') {
        this.targetMidi = typeof msg.targetMidi === 'number' ? msg.targetMidi : null
      }
    }

    const ready: PitchMessage = { type: 'ready' }
    this.port.postMessage(ready)
  }

  private rebuildBuffers() {
    this.ring = new Float32Array(this.windowSize)
    this.window = new Float32Array(this.windowSize)
    this.writeIdx = 0
    this.filled = false
    this.samplesSinceLast = 0
    this.hopSamples = Math.max(1, Math.round(sampleRate * (this.analysisIntervalMs / 1000)))
  }

  private pushSamples(input: Float32Array) {
    // Fill ring buffer with incoming samples
    for (let i = 0; i < input.length; i++) {
      this.ring[this.writeIdx] = input[i]
      this.writeIdx++
      if (this.writeIdx >= this.windowSize) {
        this.writeIdx = 0
        this.filled = true
      }
    }
  }

  private snapshotWindow() {
    // Oldest sample is at writeIdx (next write position)
    const n = this.windowSize
    const w = this.writeIdx
    const firstLen = n - w
    this.window.set(this.ring.subarray(w, n), 0)
    this.window.set(this.ring.subarray(0, w), firstLen)
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (!input) return true

    // Keep graph alive by passing input through if an output exists.
    if (output) output.set(input)

    this.pushSamples(input)
    this.samplesSinceLast += input.length

    if (this.filled && this.samplesSinceLast >= this.hopSamples) {
      this.samplesSinceLast = 0

      this.snapshotWindow()

      const hint = this.targetMidi != null ? { targetMidi: this.targetMidi } : undefined
      const t0 = (globalThis as any).performance?.now?.()
      const r = detectPitch(this.window, sampleRate, hint)
      const t1 = (globalThis as any).performance?.now?.()

      // currentTime is block start; include block duration to approximate end time.
      const blockEndTime = currentTime + input.length / sampleRate
      const halfWindowSec = (this.windowSize / sampleRate) / 2

      const msg: PitchMessage = {
        type: 'pitch',
        frequency: r.frequency,
        clarity: r.clarity,
        audioTimeSec: blockEndTime,
        halfWindowSec,
        detectMs: typeof t0 === 'number' && typeof t1 === 'number' ? (t1 - t0) : undefined
      }
      this.port.postMessage(msg)
    }

    return true
  }
}

registerProcessor('pitch-detector', PitchDetectorProcessor)


