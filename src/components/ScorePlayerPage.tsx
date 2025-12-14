import { useEffect, useMemo, useRef, useState } from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import JSZip from 'jszip'

import { ScoreTimeline, VoiceId } from '../types/ScoreTimeline'
import {
  buildScoreTimelineFromMusicXml,
  extractPartMetadata,
  buildVoiceDisplayLabel,
  PartMetadata
} from '../utils/musicXmlParser'

import { ScorePlayer, VoiceMixerSettings, midiToFrequency } from '../audio/ScorePlayer'
import { detectPitch, frequencyToNoteInfo, PitchResult, TargetHint } from '../audio/pitchDetection'

import './ScorePlayerPage.css'

/* =========================
   KONSTANTER
========================= */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const FFT_SIZE = 4096
const ANALYSIS_INTERVAL_MS = 50

// Target-window för att välja aktiv note (lite tolerant)
const ACTIVE_TOLERANCE_SEC = 0.05 // 50ms före/efter

// Vi ritar INTE i början/slutet av en not, för att slippa "rött vid tonbyte"
const NOTE_EDGE_MARGIN_SEC = 0.08 // 80ms in + 80ms före slut

// Extra attack-window vid target byte: rita inte trail här
const ATTACK_PHASE_MS = 120

// Trail: under 10 cents ritar vi inget
const TRAIL_MIN_CENTS = 10

// alpha = absCents/100
const TRAIL_MAX_CENTS_FOR_FULL = 100

function midiToNoteName(midi: number): string {
  const noteIndex = ((midi % 12) + 12) % 12
  const octave = Math.floor(midi / 12) - 1
  return NOTE_NAMES[noteIndex] + octave
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

type CursorStep = { step: number; musicalTime: number }
type CursorPos = { step: number; left: number; top: number; height: number }

export default function ScorePlayerPage() {
  /* =========================
     REFS: DOM / OSMD / PLAYHEAD
  ========================= */
  const scoreContainerRef = useRef<HTMLDivElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null)

  const cursorStepsRef = useRef<CursorStep[]>([])
  const cursorPositionsRef = useRef<CursorPos[]>([])

  /* =========================
     REFS: TRAIL CANVAS
  ========================= */
  const trailCanvasRef = useRef<HTMLCanvasElement>(null)
  const trailCtxRef = useRef<CanvasRenderingContext2D | null>(null)

  /* =========================
     REFS: PLAYER / TIMELINE
  ========================= */
  const playerRef = useRef<ScorePlayer | null>(null)
  const timelineRef = useRef<ScoreTimeline | null>(null)

  /* =========================
     REFS: AUDIO / MIC
  ========================= */
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const detectTimerRef = useRef<number | null>(null)

  /* =========================
     REFS: PITCH STATE
  ========================= */
  const stableMidiRef = useRef<number | null>(null)
  const lastTargetKeyRef = useRef<string | null>(null)
  const attackUntilPitchTimeRef = useRef<number>(0)

  const selectedVoiceRef = useRef<VoiceId | null>(null)
  const latencyMsRef = useRef<number>(0)

  /* =========================
     STATE: APP
  ========================= */
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const [scoreTimeline, setScoreTimeline] = useState<ScoreTimeline | null>(null)
  const [partMetadata, setPartMetadata] = useState<PartMetadata[]>([])

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)

  const [tempoMultiplier, setTempoMultiplier] = useState(1.0)

  const [voiceSettings, setVoiceSettings] = useState<Record<VoiceId, VoiceMixerSettings>>({})

  const [selectedVoice, setSelectedVoice] = useState<VoiceId | null>(null)

  const [micActive, setMicActive] = useState(false)
  const [pitchResult, setPitchResult] = useState<PitchResult>({ frequency: null, clarity: 0 })

  const [latencyMs, setLatencyMs] = useState(0)

  const [currentTargetNote, setCurrentTargetNote] = useState<{
    voice: VoiceId
    midi: number
    start: number
    duration: number
  } | null>(null)

  const [distanceCents, setDistanceCents] = useState<number | null>(null)

  /* =========================
     SYNC REFS
  ========================= */
  useEffect(() => {
    selectedVoiceRef.current = selectedVoice
  }, [selectedVoice])

  useEffect(() => {
    latencyMsRef.current = latencyMs
  }, [latencyMs])

  /* =========================
     OSMD INIT
  ========================= */
  useEffect(() => {
    if (!scoreContainerRef.current || osmdRef.current) return
    try {
      osmdRef.current = new OpenSheetMusicDisplay(scoreContainerRef.current, {
        autoResize: true,
        backend: 'svg',
        followCursor: false,
        drawingParameters: 'compact'
      })
      // eslint-disable-next-line no-console
      console.log('OSMD initialiserat')
    } catch (e) {
      console.error(e)
      setError('Kunde inte initiera notvisaren (OSMD).')
    }
  }, [])

  /* =========================
     TRAIL CANVAS HELPERS
  ========================= */
  function ensureTrailCanvasSize() {
    const canvas = trailCanvasRef.current
    const container = scoreContainerRef.current
    if (!canvas || !container) return

    // Canvas måste matcha scroll-ytan (inte bara viewport)
    const w = Math.max(1, container.scrollWidth)
    const h = Math.max(1, container.scrollHeight)

    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h

    // CSS storlek också (för att undvika stretch)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`

    if (!trailCtxRef.current) {
      trailCtxRef.current = canvas.getContext('2d')
    }
  }

  function clearTrail() {
    const ctx = trailCtxRef.current
    const canvas = trailCanvasRef.current
    if (!ctx || !canvas) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  function drawTrailAtPlayhead(absCents: number) {
    const ctx = trailCtxRef.current
    const canvas = trailCanvasRef.current
    const playhead = playheadRef.current
    if (!ctx || !canvas || !playhead) return

    if (absCents < TRAIL_MIN_CENTS) return

    // alpha = absCents/100
    const alpha = clamp(absCents / TRAIL_MAX_CENTS_FOR_FULL, 0, 1)
    if (alpha < 0.1) return

    // Läs playhead position (pixel i container-content coords)
    const left = parseFloat(playhead.style.left || '0')
    const top = parseFloat(playhead.style.top || '0')
    const height = parseFloat(playhead.style.height || '0') || 20

    // RÖD stapel: tjocklek 6px
    const w = 6

    ctx.fillStyle = `rgba(239, 68, 68, ${alpha})`
    ctx.fillRect(left, top, w, height)
  }

  /* =========================
     FILE LOAD
  ========================= */
  async function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setError('')
    setIsLoading(true)

    try {
      const xmlContent = await readFile(file)

      if (!osmdRef.current) throw new Error('OSMD saknas')
      await osmdRef.current.load(xmlContent)
      await osmdRef.current.render()

      // Bygg cursor mapping (musical time per cursor-step)
      buildCursorSteps()

      // Bygg position-cache för cursor (pixel-position per step)
      // (måste ske efter render)
      buildCursorPositionCache()

      const metadata = extractPartMetadata(xmlContent)
      setPartMetadata(metadata)

      const timeline = await buildScoreTimelineFromMusicXml(xmlContent)
      timelineRef.current = timeline
      setScoreTimeline(timeline)
      setCurrentTime(0)
      setIsPlaying(false)

      // trail canvas
      ensureTrailCanvasSize()
      clearTrail()

      // auto-select första human voice
      const voices = Array.from(new Set(timeline.notes.map(n => n.voice))).filter(
        v => !v.toLowerCase().includes('keyboard')
      )
      if (!selectedVoice && voices.length) setSelectedVoice(voices[0])

      // reset target/pitch
      setCurrentTargetNote(null)
      setDistanceCents(null)
      stableMidiRef.current = null
      lastTargetKeyRef.current = null
      attackUntilPitchTimeRef.current = 0
    } catch (err: any) {
      console.error(err)
      setError(`Kunde inte ladda filen: ${err?.message ?? 'Okänt fel'}`)
    } finally {
      setIsLoading(false)
    }
  }

  async function readFile(file: File): Promise<string> {
    if (!file.name.toLowerCase().endsWith('.mxl')) {
      return file.text()
    }

    const zip = await JSZip.loadAsync(await file.arrayBuffer())

    // försök container.xml
    const container = zip.file('META-INF/container.xml')
    if (container) {
      const containerXml = await container.async('text')
      const doc = new DOMParser().parseFromString(containerXml, 'application/xml')
      const rootfile = doc.querySelector('rootfile')
      const fullPath = rootfile?.getAttribute('full-path')
      if (fullPath) {
        const main = zip.file(fullPath)
        if (main) return main.async('text')
      }
    }

    // fallback
    const xmlFile =
      zip.file('score.xml') ||
      Object.values(zip.files).find(
        f => !f.dir && (f.name.endsWith('.xml') || f.name.endsWith('.musicxml')) && !f.name.includes('META-INF')
      )
    if (!xmlFile) throw new Error('Ingen XML-fil hittades i MXL-arkivet')
    return xmlFile.async('text')
  }

  /* =========================
     OSMD CURSOR MAPPING + POSITION CACHE
  ========================= */
  function buildCursorSteps() {
    const osmd = osmdRef.current
    if (!osmd) return

    const steps: CursorStep[] = []
    osmd.cursor.show()
    osmd.cursor.reset()

    let i = 0
    while (!osmd.cursor.Iterator.EndReached) {
      const ts = osmd.cursor.Iterator.CurrentSourceTimestamp
      steps.push({
        step: i,
        musicalTime: ts ? ts.RealValue : 0
      })
      osmd.cursor.next()
      i++
    }

    cursorStepsRef.current = steps
    osmd.cursor.reset()
    osmd.cursor.update()

    // eslint-disable-next-line no-console
    console.log(`Cursor mapping: ${steps.length} steps, max musicalTime=${steps[steps.length - 1]?.musicalTime ?? 0}`)
  }

  function buildCursorPositionCache() {
    const osmd = osmdRef.current
    const container = scoreContainerRef.current
    if (!osmd || !container) return
    if (cursorStepsRef.current.length === 0) return

    const positions: CursorPos[] = []

    osmd.cursor.reset()
    osmd.cursor.update()

    for (let i = 0; i < cursorStepsRef.current.length; i++) {
      const cursorEl = osmd.cursor.cursorElement
      if (cursorEl) {
        const cursorRect = cursorEl.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()

        // content coords = viewport coords + scroll offset - container viewport origin
        const left = cursorRect.left - containerRect.left + container.scrollLeft
        const top = cursorRect.top - containerRect.top + container.scrollTop
        const height = cursorRect.height

        positions.push({ step: i, left, top, height })
      }

      if (!osmd.cursor.Iterator.EndReached) {
        osmd.cursor.next()
        osmd.cursor.update()
      }
    }

    osmd.cursor.reset()
    osmd.cursor.update()

    cursorPositionsRef.current = positions
    ensureTrailCanvasSize()

    // eslint-disable-next-line no-console
    console.log(`Position-cache byggd: ${positions.length} positioner`)
  }

  /* =========================
     SCOREPLAYER CREATE/DISPOSE
  ========================= */
  useEffect(() => {
    if (!scoreTimeline) return

    if (playerRef.current) {
      playerRef.current.dispose()
      playerRef.current = null
    }

    try {
      // ScorePlayer ignorerar extra props om din ctor inte tar partMetadata
      playerRef.current = new ScorePlayer(scoreTimeline as any, { partMetadata } as any)
      timelineRef.current = scoreTimeline

      // init voice settings
      const initialSettings: Record<VoiceId, VoiceMixerSettings> = {}
      const voices = Array.from(new Set(scoreTimeline.notes.map(n => n.voice)))
      for (const v of voices) {
        initialSettings[v] = playerRef.current.getVoiceSettings(v)
      }
      setVoiceSettings(initialSettings)

      // reset marker/trail
      ensureTrailCanvasSize()
      clearTrail()
    } catch (err) {
      console.error(err)
      setError('Kunde inte skapa ljudspelare')
    }

    return () => {
      if (playerRef.current) {
        playerRef.current.dispose()
        playerRef.current = null
      }
    }
  }, [scoreTimeline, partMetadata])

  /* =========================
     PLAYER TIME TICK + AUTO-LOOP
  ========================= */
  useEffect(() => {
    if (!scoreTimeline) return

    const id = window.setInterval(() => {
      const p = playerRef.current
      if (!p) return

      const t = p.getCurrentTime()
      setCurrentTime(t)
      setIsPlaying(p.isPlaying())

      // auto-loop
      const dur = scoreTimeline.totalDurationSeconds
      if (p.isPlaying() && t >= dur - 0.05) {
        p.seekTo(0)
        p.play()

        // reset osmd cursor + caches align ok
        osmdRef.current?.cursor.reset()
        osmdRef.current?.cursor.update()

        clearTrail()
        setCurrentTargetNote(null)
        setDistanceCents(null)
        stableMidiRef.current = null
        lastTargetKeyRef.current = null
        attackUntilPitchTimeRef.current = 0
      }
    }, 100)

    return () => window.clearInterval(id)
  }, [scoreTimeline])

  /* =========================
     PLAYHEAD ANIMATION (OSMD cursor mapping -> pixel position)
  ========================= */
  useEffect(() => {
    if (!scoreTimeline) return
    if (!playerRef.current || !osmdRef.current) return

    let raf = 0
    let lastStep = -1

    const update = () => {
      const player = playerRef.current
      const playhead = playheadRef.current
      const container = scoreContainerRef.current
      const steps = cursorStepsRef.current
      const posCache = cursorPositionsRef.current

      if (!player || !playhead || !container || steps.length === 0 || posCache.length === 0) {
        raf = requestAnimationFrame(update)
        return
      }

      if (player.isPlaying()) {
        const t = player.getCurrentTime()
        const tempoBpm = scoreTimeline.tempoBpm

        // wall-clock sec -> musical time (whole fractions)
        let musicalTime = (t * tempoBpm) / 240
        const maxMusical = steps[steps.length - 1]?.musicalTime ?? 0
        musicalTime = clamp(musicalTime, 0, maxMusical)

        // hitta step index
        let idx = 0
        for (let i = 0; i < steps.length; i++) {
          if (steps[i].musicalTime <= musicalTime) idx = i
          else break
        }

        const step = steps[idx]?.step ?? 0

        // flytta OSMD cursor ibland (för att hålla den "synkad")
        if (step !== lastStep) {
          const osmd = osmdRef.current
          if (osmd) {
            osmd.cursor.reset()
            for (let i = 0; i < step; i++) {
              if (osmd.cursor.Iterator.EndReached) break
              osmd.cursor.next()
            }
            osmd.cursor.update()
          }
          lastStep = step
        }

        // interpolera pixel mellan posCache[idx] och posCache[idx+1]
        const cur = steps[idx]
        const nxt = steps[idx + 1]
        const curPos = posCache[idx]
        const nxtPos = posCache[idx + 1]

        if (cur && nxt && curPos && nxtPos && nxt.musicalTime > cur.musicalTime) {
          const prog = (musicalTime - cur.musicalTime) / (nxt.musicalTime - cur.musicalTime)
          const left = curPos.left + (nxtPos.left - curPos.left) * prog
          playhead.style.left = `${left}px`
          playhead.style.top = `${curPos.top}px`
          playhead.style.height = `${curPos.height}px`
        } else if (curPos) {
          playhead.style.left = `${curPos.left}px`
          playhead.style.top = `${curPos.top}px`
          playhead.style.height = `${curPos.height}px`
        }

        // Auto-scroll: håll playhead inom viewport
        const phTop = parseFloat(playhead.style.top || '0')
        const viewTop = container.scrollTop
        const viewH = container.clientHeight
        const marginBottom = 180
        const marginTop = 80

        if (phTop > viewTop + viewH - marginBottom) {
          container.scrollTop = Math.max(0, phTop - viewH / 2)
        } else if (phTop < viewTop + marginTop) {
          container.scrollTop = Math.max(0, phTop - marginTop)
        }
      }

      raf = requestAnimationFrame(update)
    }

    raf = requestAnimationFrame(update)
    return () => cancelAnimationFrame(raf)
  }, [scoreTimeline])

  /* =========================
     TRANSPORT
  ========================= */
  function handlePlayPause() {
    const p = playerRef.current
    if (!p) return

    if (p.isPlaying()) {
      p.pause()
    } else {
      // sync canvas size once when starting
      ensureTrailCanvasSize()
      p.play()
    }
  }

  function handleStop() {
    const p = playerRef.current
    if (!p) return
    p.stop()
    setCurrentTime(0)
    setIsPlaying(false)

    osmdRef.current?.cursor.reset()
    osmdRef.current?.cursor.update()

    // reset pitch-related
    setCurrentTargetNote(null)
    setDistanceCents(null)
    stableMidiRef.current = null
    lastTargetKeyRef.current = null
    attackUntilPitchTimeRef.current = 0

    clearTrail()
  }

  function handleSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const t = parseFloat(e.target.value)
    setCurrentTime(t)
    const p = playerRef.current
    if (!p) return
    p.seekTo(t)
  }

  function handleTempoChange(mult: number) {
    setTempoMultiplier(mult)
    const p = playerRef.current
    if (!p || !scoreTimeline) return
    p.setTempoMultiplier(mult)
  }

  function getVoices(): VoiceId[] {
    if (!scoreTimeline) return []
    return Array.from(new Set(scoreTimeline.notes.map(n => n.voice)))
  }

  function getVoiceSettings(voice: VoiceId): VoiceMixerSettings {
    return (
      voiceSettings[voice] || {
        volume: 1.0,
        muted: false,
        solo: false
      }
    )
  }

  function handleVoiceSettingsChange(voice: VoiceId, settings: Partial<VoiceMixerSettings>) {
    setVoiceSettings(prev => ({
      ...prev,
      [voice]: { ...prev[voice], ...settings }
    }))
    playerRef.current?.setVoiceSettings(voice, settings)
  }

  /* =========================
     MIC TOGGLE
  ========================= */
  async function handleMicToggle() {
    if (micActive) {
      stopMic()
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      })
      micStreamRef.current = stream

      if (!audioContextRef.current) audioContextRef.current = new AudioContext()

      const source = audioContextRef.current.createMediaStreamSource(stream)
      const analyser = audioContextRef.current.createAnalyser()
      analyser.fftSize = FFT_SIZE
      analyser.smoothingTimeConstant = 0.3
      source.connect(analyser)
      analyserRef.current = analyser

      setMicActive(true)

      // reset pitch state
      setPitchResult({ frequency: null, clarity: 0 })
      setDistanceCents(null)
      stableMidiRef.current = null

      startDetectLoop()
    } catch (err) {
      console.error(err)
      setError('Kunde inte aktivera mikrofon. Kontrollera behörigheter.')
    }
  }

  function stopMic() {
    if (detectTimerRef.current) window.clearTimeout(detectTimerRef.current)
    detectTimerRef.current = null

    micStreamRef.current?.getTracks().forEach(t => t.stop())
    micStreamRef.current = null
    analyserRef.current = null

    setMicActive(false)
    setPitchResult({ frequency: null, clarity: 0 })
    setDistanceCents(null)
  }

  /* =========================
     TARGET PICKER (max 2 candidates scenario)
  ========================= */
  function pickTargetAtTime(timeline: ScoreTimeline, voice: VoiceId, pitchTime: number) {
    const notes = timeline.notes.filter(n => n.voice === voice)

    // candidates in tolerant window
    const candidates = notes.filter(
      n =>
        pitchTime >= n.startTimeSeconds - ACTIVE_TOLERANCE_SEC &&
        pitchTime <= n.startTimeSeconds + n.durationSeconds + ACTIVE_TOLERANCE_SEC
    )

    if (candidates.length === 0) return null

    // Prefer a note where pitchTime is inside strict interval excluding edge margins
    const strict = candidates.filter(n => {
      const s = n.startTimeSeconds + NOTE_EDGE_MARGIN_SEC
      const e = n.startTimeSeconds + n.durationSeconds - NOTE_EDGE_MARGIN_SEC
      return pitchTime >= s && pitchTime <= e
    })

    const pool = strict.length > 0 ? strict : candidates

    // Pick the note whose center is closest (helps when 2 overlap)
    let best = pool[0]
    let bestDist = Infinity
    for (const n of pool) {
      const center = n.startTimeSeconds + n.durationSeconds / 2
      const d = Math.abs(center - pitchTime)
      if (d < bestDist) {
        bestDist = d
        best = n
      }
    }

    return {
      voice,
      midi: best.midiPitch,
      start: best.startTimeSeconds,
      duration: best.durationSeconds
    }
  }

  /* =========================
     PITCH LOOP
  ========================= */
  function startDetectLoop() {
    const loop = () => {
      const analyser = analyserRef.current
      const ctx = audioContextRef.current
      const timeline = timelineRef.current
      const player = playerRef.current
      const voice = selectedVoiceRef.current

      if (!analyser || !ctx) {
        detectTimerRef.current = window.setTimeout(loop, ANALYSIS_INTERVAL_MS)
        return
      }

      const buffer = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(buffer)

      // window timing
      const sr = ctx.sampleRate
      const windowSec = analyser.fftSize / sr
      const halfWindowSec = windowSec / 2

      // pitchTime: align mic-window center with playback time minus latency
      const rawNow = player?.getCurrentTime() ?? 0
      const correctedNow = rawNow - (latencyMsRef.current || 0) / 1000
      const pitchTime = correctedNow - halfWindowSec

      // choose target note
      let targetMidi: number | null = null
      let targetKey: string | null = null
      let targetForUi: typeof currentTargetNote | null = null

      if (timeline && voice) {
        const t = pickTargetAtTime(timeline, voice, pitchTime)
        if (t) {
          targetMidi = t.midi
          targetForUi = t
          targetKey = `${t.voice}|${t.start.toFixed(3)}|${t.midi}`
        }
      }

      // Update UI target + attack window on target change
      if (targetForUi && targetKey) {
        if (lastTargetKeyRef.current !== targetKey) {
          lastTargetKeyRef.current = targetKey
          setCurrentTargetNote(targetForUi)

          // reset smoothing so we don't "drag" old note into new note
          stableMidiRef.current = null

          // set attack window (no trail drawing)
          attackUntilPitchTimeRef.current = pitchTime + ATTACK_PHASE_MS / 1000
        }
      } else {
        lastTargetKeyRef.current = null
        setCurrentTargetNote(null)
        stableMidiRef.current = null
        setDistanceCents(null)
      }

      // Detect pitch (target-aware)
      const hint: TargetHint | undefined = targetMidi != null ? ({ targetMidi } as TargetHint) : undefined
      const result = detectPitch(buffer, sr, hint)
      setPitchResult(result)

      // Compute cents deviation
      if (result.frequency && targetMidi != null) {
        const noteInfo = frequencyToNoteInfo(result.frequency)
        if (noteInfo) {
          const rawMidi = noteInfo.exactMidi

          // Fast EMA for stability but still responsive
          const prev = stableMidiRef.current
          const stable = prev == null ? rawMidi : prev * 0.65 + rawMidi * 0.35
          stableMidiRef.current = stable

          const cents = 1200 * Math.log2(midiToFrequency(stable) / midiToFrequency(targetMidi))
          setDistanceCents(cents)

          // Draw trail only if:
          // - not in attack window
          // - and we are not within note edge margin
          const inAttack = pitchTime < attackUntilPitchTimeRef.current

          // Also: ensure pitchTime is not close to the target note's edges
          let nearEdge = false
          if (targetForUi) {
            const s = targetForUi.start
            const e = targetForUi.start + targetForUi.duration
            nearEdge =
              Math.abs(pitchTime - s) < NOTE_EDGE_MARGIN_SEC ||
              Math.abs(pitchTime - e) < NOTE_EDGE_MARGIN_SEC
          }

          if (!inAttack && !nearEdge && Number.isFinite(cents)) {
            ensureTrailCanvasSize()
            drawTrailAtPlayhead(Math.abs(cents))
          }
        } else {
          setDistanceCents(null)
        }
      } else {
        setDistanceCents(null)
      }

      detectTimerRef.current = window.setTimeout(loop, ANALYSIS_INTERVAL_MS)
    }

    loop()
  }

  /* =========================
     CANVAS RESIZE ON SCROLL/RESIZE
  ========================= */
  useEffect(() => {
    const container = scoreContainerRef.current
    if (!container) return

    const onScroll = () => {
      // canvas ligger i content-coords, så den följer scroll.
      // Men om OSMD reflowar kan scrollWidth/Height ändras.
      ensureTrailCanvasSize()
    }

    const onResize = () => {
      // OSMD kan reflowa system -> rebuild caches
      ensureTrailCanvasSize()
      buildCursorSteps()
      buildCursorPositionCache()
    }

    container.addEventListener('scroll', onScroll)
    window.addEventListener('resize', onResize)

    return () => {
      container.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreTimeline])

  /* =========================
     CLEANUP
  ========================= */
  useEffect(() => {
    return () => {
      stopMic()
      playerRef.current?.dispose()
      playerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* =========================
     DERIVED
  ========================= */
  const voicesHuman = useMemo(() => {
    return getVoices().filter(v => !v.toLowerCase().includes('keyboard'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreTimeline, partMetadata])

  /* =========================
     RENDER
  ========================= */
  return (
    <div className="score-player-page">
      <header className="top-bar">
        <h1>Choir Practice Tool</h1>
      </header>

      <main className="main-content">
        <div className="score-section">
          <div className="file-upload-section">
            <label htmlFor="musicxml-file" className="file-upload-button">
              Välj MusicXML/MXL-fil
            </label>
            <input
              id="musicxml-file"
              type="file"
              accept=".xml,.musicxml,.mxl"
              onChange={handleFileSelect}
              className="file-input"
            />
            {isLoading && <p className="status-text">Laddar...</p>}
            {error && <p className="error-text">{error}</p>}
          </div>

          <div ref={scoreContainerRef} id="score-container" className="score-container">
            {!scoreTimeline && <p>Välj en MusicXML- eller MXL-fil för att visa noter</p>}

            {scoreTimeline && (
              <>
                {/* trail overlay */}
                <canvas ref={trailCanvasRef} className="trail-canvas" />

                {/* playhead */}
                <div ref={playheadRef} className="playhead-marker" />

                {/* overlay pitch info */}
                {micActive && isPlaying && currentTargetNote && (
                  <div className="pitch-detector-overlay">
                    <div className="pitch-detector-content">
                      <div className="sung-note">
                        {pitchResult.frequency
                          ? frequencyToNoteInfo(pitchResult.frequency)?.noteName ?? '---'
                          : '---'}
                      </div>

                      <div className="target-note">
                        Mål: {midiToNoteName(currentTargetNote.midi)}
                      </div>

                      <div className="pitch-info">
                        <span className="pitch-hz">
                          {pitchResult.frequency ? `${pitchResult.frequency.toFixed(1)} Hz` : '--- Hz'}
                        </span>
                        <span className="pitch-cents">
                          {distanceCents != null
                            ? `${distanceCents > 0 ? '+' : ''}${Math.round(distanceCents)} cent`
                            : '--- cent'}
                        </span>
                        <span className="pitch-clarity">
                          Clarity: {Math.round((pitchResult.clarity ?? 0) * 100)}%
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {scoreTimeline && (
            <div className="timeline-debug">
              <h4>Debug-info:</h4>
              <p>Antal noter: {scoreTimeline.notes.length}</p>
              <p>Total längd: {scoreTimeline.totalDurationSeconds.toFixed(1)} sekunder</p>
              <p>Tempo: {scoreTimeline.tempoBpm} bpm</p>
            </div>
          )}
        </div>

        <aside className="control-panel">
          <h3>Kontroller</h3>

          {scoreTimeline ? (
            <>
              <div className="voice-selection">
                <h4>🎤 Välj stämma att öva</h4>
                <select
                  value={selectedVoice || ''}
                  onChange={e => setSelectedVoice(e.target.value as VoiceId)}
                >
                  {!selectedVoice && <option value="">Välj stämma...</option>}
                  {voicesHuman.map(v => (
                    <option key={v} value={v}>
                      {buildVoiceDisplayLabel(v, getVoices(), partMetadata)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="player-controls">
                <h3>Spelare</h3>

                <div className="transport-controls">
                  <button onClick={handlePlayPause}>{isPlaying ? 'Pause' : 'Play'}</button>
                  <button onClick={handleStop}>Stop</button>
                </div>

                <div className="timeline-control">
                  <label>
                    Tid: {currentTime.toFixed(1)}s / {scoreTimeline.totalDurationSeconds.toFixed(1)}s
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={scoreTimeline.totalDurationSeconds}
                    step={0.05}
                    value={currentTime}
                    onChange={handleSeek}
                    className="timeline-slider"
                  />
                </div>

                <div className="tempo-control">
                  <h4>🎵 Tempo</h4>
                  <div className="tempo-display">
                    {Math.round(scoreTimeline.tempoBpm * tempoMultiplier)} BPM
                    <span className="tempo-original">({scoreTimeline.tempoBpm} BPM original)</span>
                  </div>

                  <div className="tempo-buttons">
                    {[0.5, 0.75, 1.0, 1.25, 1.5].map(m => (
                      <button
                        key={m}
                        onClick={() => handleTempoChange(m)}
                        className={tempoMultiplier === m ? 'active' : ''}
                      >
                        {m}x
                      </button>
                    ))}
                  </div>

                  <input
                    type="range"
                    min={0.25}
                    max={2.0}
                    step={0.05}
                    value={tempoMultiplier}
                    onChange={e => handleTempoChange(parseFloat(e.target.value))}
                    className="tempo-slider"
                  />
                </div>
              </div>

              <div className="pitch-detector">
                <h4>Tuner</h4>
                <button onClick={handleMicToggle}>
                  {micActive ? 'Stoppa mikrofon' : 'Aktivera mikrofon'}
                </button>

                {micActive && !isPlaying && (
                  <div className="pitch-display">
                    {pitchResult.frequency ? (
                      <>
                        <div className="pitch-frequency">
                          Frekvens: {pitchResult.frequency.toFixed(1)} Hz
                        </div>
                        <div className="pitch-note">
                          Not: {frequencyToNoteInfo(pitchResult.frequency)?.noteName ?? '---'}
                        </div>
                        <div className="pitch-clarity">
                          Klarhet: {Math.round((pitchResult.clarity ?? 0) * 100)}%
                        </div>
                      </>
                    ) : (
                      <div className="pitch-no-signal">Ingen stabil pitch detekterad</div>
                    )}
                  </div>
                )}
              </div>

              {micActive && (
                <div className="latency-control">
                  <h4>⏱️ Latency Compensation</h4>
                  <label>Mic/Playback latency: {latencyMs} ms</label>
                  <input
                    type="range"
                    min={0}
                    max={400}
                    step={10}
                    value={latencyMs}
                    onChange={e => setLatencyMs(parseInt(e.target.value, 10))}
                  />
                </div>
              )}

              <div className="voice-mixer">
                <h4>Stämmor</h4>
                {getVoices().map(v => {
                  const settings = getVoiceSettings(v)
                  const label = buildVoiceDisplayLabel(v, getVoices(), partMetadata)
                  return (
                    <div key={v} className="mixer-voice-row">
                      <div className="mixer-voice-name">{label}</div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={settings.volume * 100}
                        onChange={e =>
                          handleVoiceSettingsChange(v, { volume: parseInt(e.target.value) / 100 })
                        }
                      />
                      <button
                        onClick={() => handleVoiceSettingsChange(v, { muted: !settings.muted })}
                        className={settings.muted ? 'active' : ''}
                      >
                        {settings.muted ? '🔇' : '🔊'}
                      </button>
                      <button
                        onClick={() => handleVoiceSettingsChange(v, { solo: !settings.solo })}
                        className={settings.solo ? 'active' : ''}
                      >
                        S
                      </button>
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            <p>Ladda en fil först.</p>
          )}
        </aside>
      </main>
    </div>
  )
}
