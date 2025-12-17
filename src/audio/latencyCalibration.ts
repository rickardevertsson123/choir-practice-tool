export type CalibrateOptions = {
  audioContext?: AudioContext | null
  existingStream?: MediaStream | null
  durationMs?: number
}

function median(arr: number[]) {
  const s = arr.slice().sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  if (s.length === 0) return 0
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export async function calibrateLatency(opts: CalibrateOptions = {}): Promise<number> {
  const durationMs = opts.durationMs ?? 6000
  const ctx = opts.audioContext ?? new (window.AudioContext || (window as any).webkitAudioContext)()
  let openedStream = false
  let stream: MediaStream | null = opts.existingStream ?? null

  try {
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      openedStream = true
    }

    const micSource = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    micSource.connect(analyser)

    // create a short percussive click buffer (~8ms)
    const clickLen = Math.max(1, Math.floor(ctx.sampleRate * 0.008))
    const clickBuf = ctx.createBuffer(1, clickLen, ctx.sampleRate)
    const data = clickBuf.getChannelData(0)
    for (let i = 0; i < clickLen; i++) {
      // decaying noise
      const env = Math.exp(-5 * (i / clickLen))
      data[i] = (Math.random() * 2 - 1) * env * 0.6
    }

    const intervalMs = 350
    const count = Math.max(3, Math.floor(durationMs / intervalMs))
    const expectedTimes: number[] = []
    const detections: number[] = []
    const matched: boolean[] = new Array(count).fill(false)

    // schedule clicks a little in the future to avoid scheduling issues
    const startTime = ctx.currentTime + 0.15
    for (let i = 0; i < count; i++) {
      const src = ctx.createBufferSource()
      src.buffer = clickBuf
      src.connect(ctx.destination)
      const t = startTime + (i * intervalMs) / 1000
      expectedTimes.push(t)
      src.start(t)
    }

    const threshold = 0.12
    const minDetectGapMs = 80
    let lastDetectTime = 0

    const sampleBuf = new Float32Array(analyser.fftSize)

    return await new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        // compute results
        if (detections.length === 0) {
          cleanup()
          reject(new Error('No clicks detected'))
          return
        }

        // match detections to expected times greedily
        const diffs: number[] = []
        for (const d of detections) {
          // find nearest expected time not matched
          let bestIdx = -1
          let bestDist = Infinity
          for (let i = 0; i < expectedTimes.length; i++) {
            if (matched[i]) continue
            const dist = Math.abs(d - expectedTimes[i])
            if (dist < bestDist) {
              bestDist = dist
              bestIdx = i
            }
          }
          if (bestIdx !== -1) {
            matched[bestIdx] = true
            diffs.push((d - expectedTimes[bestIdx]) * 1000)
          }
        }

        if (diffs.length === 0) {
          cleanup()
          reject(new Error('Could not match detections'))
          return
        }

        // use median to be robust
        const ms = median(diffs)
        cleanup()
        resolve(ms)
      }, durationMs + 800)

      const poll = () => {
        analyser.getFloatTimeDomainData(sampleBuf)
        let max = 0
        for (let i = 0; i < sampleBuf.length; i++) {
          const v = Math.abs(sampleBuf[i])
          if (v > max) max = v
        }

        const now = ctx.currentTime
        if (max > threshold && (now * 1000 - lastDetectTime) > minDetectGapMs) {
          lastDetectTime = now * 1000
          // record detection time
          detections.push(now)
        }

        // stop early if we have matched most expected clicks
        if (detections.length >= Math.max(3, Math.floor(expectedTimes.length * 0.6))) {
          // give a small buffer then resolve early
          window.setTimeout(() => {
            // trigger the same resolution logic by letting the main timeout handle it
          }, 200)
        }

        pollTimer = window.setTimeout(poll, 20)
      }

      let pollTimer = window.setTimeout(poll, 30)

      function cleanup() {
        window.clearTimeout(timeout)
        window.clearTimeout(pollTimer)
        try {
          analyser.disconnect()
        } catch (e) {}
        try {
          micSource.disconnect()
        } catch (e) {}
        if (openedStream && stream) {
          stream.getTracks().forEach(t => t.stop())
        }
      }
    })
  } catch (err) {
    if (openedStream && stream) stream.getTracks().forEach(t => t.stop())
    throw err
  }
}

export type HeadphoneCalibrateOptions = CalibrateOptions & {
  intervalMs?: number
  clicks?: number
  threshold?: number
}

export async function calibrateLatencyHeadphones(opts: HeadphoneCalibrateOptions = {}): Promise<number> {
  const intervalMs = opts.intervalMs ?? 800
  const clicks = opts.clicks ?? 8
  const threshold = opts.threshold ?? 0.08
  const ctx = opts.audioContext ?? new (window.AudioContext || (window as any).webkitAudioContext)()
  let openedStream = false
  let stream: MediaStream | null = opts.existingStream ?? null

  try {
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      openedStream = true
    }

    const micSource = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    micSource.connect(analyser)

    // create a clear click sound
    const clickLen = Math.max(1, Math.floor(ctx.sampleRate * 0.01))
    const clickBuf = ctx.createBuffer(1, clickLen, ctx.sampleRate)
    const data = clickBuf.getChannelData(0)
    for (let i = 0; i < clickLen; i++) {
      // a short impulse
      data[i] = (i === 0) ? 1.0 : Math.exp(-10 * (i / clickLen))
    }

    const expectedTimes: number[] = []
    const detections: number[] = []
    const matched: boolean[] = new Array(clicks).fill(false)

    const startTime = ctx.currentTime + 0.15
    for (let i = 0; i < clicks; i++) {
      const src = ctx.createBufferSource()
      src.buffer = clickBuf
      src.connect(ctx.destination)
      const t = startTime + (i * intervalMs) / 1000
      expectedTimes.push(t)
      src.start(t)
    }

    const sampleBuf = new Float32Array(analyser.fftSize)

    return await new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (detections.length === 0) {
          cleanup()
          reject(new Error('No responses detected'))
          return
        }

        // match detections to expected times
        const diffs: number[] = []
        for (const d of detections) {
          let bestIdx = -1
          let bestDist = Infinity
          for (let i = 0; i < expectedTimes.length; i++) {
            if (matched[i]) continue
            const dist = Math.abs(d - expectedTimes[i])
            if (dist < bestDist) {
              bestDist = dist
              bestIdx = i
            }
          }
          if (bestIdx !== -1) {
            matched[bestIdx] = true
            diffs.push((d - expectedTimes[bestIdx]) * 1000)
          }
        }

        if (diffs.length === 0) {
          cleanup()
          reject(new Error('Could not match responses'))
          return
        }

        const ms = median(diffs)
        cleanup()
        resolve(ms)
      }, clicks * intervalMs + 1500)

      let lastDetectMs = 0
      const minGapMs = 120

      const poll = () => {
        analyser.getFloatTimeDomainData(sampleBuf)
        let max = 0
        for (let i = 0; i < sampleBuf.length; i++) {
          const v = Math.abs(sampleBuf[i])
          if (v > max) max = v
        }

        const now = ctx.currentTime
        if (max > threshold && (now * 1000 - lastDetectMs) > minGapMs) {
          lastDetectMs = now * 1000
          detections.push(now)
        }

        pollTimer = window.setTimeout(poll, 25)
      }

      let pollTimer = window.setTimeout(poll, 30)

      function cleanup() {
        window.clearTimeout(timeout)
        window.clearTimeout(pollTimer)
        try { analyser.disconnect() } catch (e) {}
        try { micSource.disconnect() } catch (e) {}
        if (openedStream && stream) stream.getTracks().forEach(t => t.stop())
      }
    })
  } catch (err) {
    if (openedStream && stream) stream.getTracks().forEach(t => t.stop())
    throw err
  }
}
