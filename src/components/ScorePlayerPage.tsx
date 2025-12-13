import { useEffect, useRef, useState } from 'react'
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
import { detectPitch, frequencyToNoteInfo, PitchResult } from '../audio/pitchDetection'
import { PitchDeviationGate } from '../audio/PitchDeviationGate'

import './ScorePlayerPage.css'

/* =========================
   KONSTANTER
========================= */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const FFT_SIZE = 4096
const ANALYSIS_INTERVAL_MS = 50

const ACTIVE_TOLERANCE_SEC = 0.05 // 50ms före/efter
const MIN_CLARITY = 0.4
const ATTACK_PHASE_MS = 80 // “lås-fas” efter notbyte

function midiToNoteName(midi: number): string {
  const noteIndex = ((midi % 12) + 12) % 12
  const octave = Math.floor(midi / 12) - 1
  return NOTE_NAMES[noteIndex] + octave
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

export default function ScorePlayerPage() {
  /* =========================
     REFS: DOM / OSMD
  ========================= */
  const scoreContainerRef = useRef<HTMLDivElement>(null)
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null)

  // Custom playhead overlay
  const playheadRef = useRef<HTMLDivElement>(null)

  // OSMD cursor → musicalTime mapping + cached positions
  const cursorStepsRef = useRef<Array<{ step: number; musicalTime: number }>>([])
  const cursorPositionsRef = useRef<Array<{ step: number; left: number; top: number; height: number }>>([])
  const maxMusicalTimeRef = useRef<number>(0)

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
     REFS: PITCH / STABILISERING
  ========================= */
  const stableMidiRef = useRef<number | null>(null)
  const lastTargetMidiRef = useRef<number | null>(null)
  const targetStartRef = useRef<number | null>(null) // startTimeSeconds för aktuell target
  const attackUntilRef = useRef<number>(0) // pitchTime (sek) när attack slutar

  // Gate: 2 frames, spike-threshold 120 cents (du hade detta)
  const deviationGateRef = useRef(new PitchDeviationGate(2, 120))

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
  const selectedVoiceRef = useRef<VoiceId | null>(null)

  const [micActive, setMicActive] = useState(false)
  const [pitchResult, setPitchResult] = useState<PitchResult>({ frequency: null, clarity: 0 })

  const [latencyMs, setLatencyMs] = useState(220)
  const latencyMsRef = useRef(latencyMs)

  const [currentTargetNote, setCurrentTargetNote] = useState<{
    voice: VoiceId
    midi: number
    start: number
    duration: number
  } | null>(null)

  // IMPORTANT: use ref for target inside the loop (avoid stale state closure)
  const currentTargetNoteRef = useRef<{
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

  useEffect(() => {
    currentTargetNoteRef.current = currentTargetNote
  }, [currentTargetNote])

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
    } catch (e) {
      console.error(e)
      setError('Kunde inte initiera notvisaren (OSMD).')
    }
  }, [])

  // Build mapping from OSMD cursor steps to screen positions (relative to the scroll container).
  const buildCursorMaps = () => {
    const osmd = osmdRef.current
    const container = scoreContainerRef.current
    if (!osmd || !container) return

    try {
      osmd.cursor.show()
      osmd.cursor.reset()

      const steps: Array<{ step: number; musicalTime: number }> = []
      let i = 0
      while (!osmd.cursor.Iterator.EndReached) {
        const ts = osmd.cursor.Iterator.CurrentSourceTimestamp
        steps.push({ step: i, musicalTime: ts ? ts.RealValue : 0 })
        osmd.cursor.next()
        i++
        if (i > 20000) break
      }

      cursorStepsRef.current = steps
      maxMusicalTimeRef.current = steps.length ? steps[steps.length - 1].musicalTime : 0

      const positions: Array<{ step: number; left: number; top: number; height: number }> = []
      osmd.cursor.reset()

      const containerRect = container.getBoundingClientRect()
      for (let s = 0; s < steps.length; s++) {
        osmd.cursor.update()
        const el = osmd.cursor.cursorElement as SVGElement | null
        if (el) {
          const r = el.getBoundingClientRect()
          const left = r.left - containerRect.left + container.scrollLeft
          const top = r.top - containerRect.top + container.scrollTop
          const height = r.height
          positions.push({
            step: s,
            left: Math.max(0, left),
            top: Math.max(0, top),
            height: Math.max(0, height)
          })
        } else {
          positions.push({ step: s, left: 0, top: 0, height: 0 })
        }

        if (!osmd.cursor.Iterator.EndReached) {
          osmd.cursor.next()
        }
      }

      cursorPositionsRef.current = positions
      osmd.cursor.hide()
    } catch (err) {
      console.warn('buildCursorMaps failed:', err)
    }
  }

  const updatePlayheadPosition = () => {
    const p = playerRef.current
    const tl = timelineRef.current
    const container = scoreContainerRef.current
    const playhead = playheadRef.current
    if (!p || !tl || !container || !playhead) return
    if (!cursorStepsRef.current.length || !cursorPositionsRef.current.length) return

    const tSec = p.getCurrentTime()

    let musicalTime = (tSec * tl.tempoBpm) / 240
    musicalTime = clamp(musicalTime, 0, maxMusicalTimeRef.current || 0)

    const steps = cursorStepsRef.current
    let idx = 0
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].musicalTime <= musicalTime) idx = i
      else break
    }

    const posA = cursorPositionsRef.current[idx]
    const stepA = steps[idx]
    const stepB = steps[idx + 1]
    const posB = cursorPositionsRef.current[idx + 1]

    let left = posA?.left ?? 0
    let top = posA?.top ?? 0
    let height = posA?.height ?? 0

    if (stepA && stepB && posB && stepB.musicalTime > stepA.musicalTime) {
      const prog = (musicalTime - stepA.musicalTime) / (stepB.musicalTime - stepA.musicalTime)
      left = (posA?.left ?? 0) + ((posB.left ?? 0) - (posA?.left ?? 0)) * clamp(prog, 0, 1)
      top = posA?.top ?? top
      height = posA?.height ?? height
    }

    playhead.style.left = `${left}px`
    playhead.style.top = `${top}px`
    playhead.style.height = `${Math.max(10, height)}px`

    const viewTop = container.scrollTop
    const viewBottom = viewTop + container.clientHeight
    const marginTop = 120
    const marginBottom = 200

    if (top < viewTop + marginTop) {
      container.scrollTop = Math.max(0, top - marginTop)
    } else if (top + height > viewBottom - marginBottom) {
      container.scrollTop = Math.max(0, top + height - (container.clientHeight - marginBottom))
    }
  }

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const p = playerRef.current
      if (p && p.isPlaying()) updatePlayheadPosition()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreTimeline])

  useEffect(() => {
    if (!scoreTimeline) return
    const container = scoreContainerRef.current
    if (!container) return

    let t: number | null = null
    const schedule = () => {
      if (t != null) window.clearTimeout(t)
      t = window.setTimeout(() => buildCursorMaps(), 120)
    }

    const ro = new ResizeObserver(schedule)
    ro.observe(container)
    window.addEventListener('resize', schedule)
    schedule()

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      if (t != null) window.clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreTimeline])

  /* =========================
     CANVAS INIT
  ========================= */
  const resizeTrailCanvas = () => {
    const canvas = trailCanvasRef.current
    const container = scoreContainerRef.current
    if (!canvas || !container) return

    const cssW = Math.max(1, container.scrollWidth)
    const cssH = Math.max(1, container.scrollHeight)

    const dpr = window.devicePixelRatio || 1
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)

    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      trailCtxRef.current = ctx
    }
  }

  useEffect(() => {
    resizeTrailCanvas()

    const container = scoreContainerRef.current
    if (!container) return

    let t: number | null = null
    const schedule = () => {
      if (t != null) window.clearTimeout(t)
      t = window.setTimeout(() => {
        resizeTrailCanvas()
      }, 80)
    }

    const ro = new ResizeObserver(schedule)
    ro.observe(container)
    window.addEventListener('resize', schedule)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      if (t != null) window.clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreTimeline])

  function clearTrail() {
    const ctx = trailCtxRef.current
    const canvas = trailCanvasRef.current
    if (!ctx || !canvas) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.restore()
  }

  function drawTrailMark(absCents: number) {
    const ctx = trailCtxRef.current
    const playhead = playheadRef.current
    if (!ctx || !playhead) return

    if (!Number.isFinite(absCents)) return
    if (absCents < 10) return

    const alpha = clamp(absCents / 100, 0, 1)
    ctx.fillStyle = `rgba(239, 68, 68, ${alpha})`

    const x = parseFloat(playhead.style.left || '0')
    const y = parseFloat(playhead.style.top || '0')
    const h = parseFloat(playhead.style.height || '0') || 40
    const w = 6

    ctx.fillRect(x, y, w, h)
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

      buildCursorMaps()

      const metadata = extractPartMetadata(xmlContent)
      setPartMetadata(metadata)

      const timeline = await buildScoreTimelineFromMusicXml(xmlContent)
      timelineRef.current = timeline
      setScoreTimeline(timeline)
      setCurrentTime(0)

      clearTrail()

      const voices = Array.from(new Set(timeline.notes.map(n => n.voice))).filter(
        v => !v.toLowerCase().includes('keyboard')
      )
      if (!selectedVoice && voices.length) setSelectedVoice(voices[0])
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

    const xmlFile =
      zip.file('score.xml') ||
      Object.values(zip.files).find(
        f => !f.dir && (f.name.endsWith('.xml') || f.name.endsWith('.musicxml')) && !f.name.includes('META-INF')
      )
    if (!xmlFile) throw new Error('Ingen XML-fil hittades i MXL-arkivet')
    return xmlFile.async('text')
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
      playerRef.current = new ScorePlayer(scoreTimeline, { partMetadata })
      timelineRef.current = scoreTimeline

      const initialSettings: Record<VoiceId, VoiceMixerSettings> = {}
      const voices = Array.from(new Set(scoreTimeline.notes.map(n => n.voice)))
      for (const v of voices) {
        initialSettings[v] = playerRef.current.getVoiceSettings(v)
      }
      setVoiceSettings(initialSettings)
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
     PLAYER TIME TICK
  ========================= */
  useEffect(() => {
    if (!scoreTimeline) return

    const id = window.setInterval(() => {
      const p = playerRef.current
      if (!p) return
      const t = p.getCurrentTime()
      setCurrentTime(t)
      setIsPlaying(p.isPlaying())
    }, 100)

    return () => window.clearInterval(id)
  }, [scoreTimeline])

  /* =========================
     TRANSPORT
  ========================= */
  function handlePlayPause() {
    const p = playerRef.current
    if (!p) return
    if (p.isPlaying()) p.pause()
    else {
      if (!cursorStepsRef.current.length || !cursorPositionsRef.current.length) {
        buildCursorMaps()
      }
      p.play()
    }
  }

  function handleStop() {
    const p = playerRef.current
    if (!p) return
    p.stop()
    setCurrentTime(0)
    setIsPlaying(false)

    setCurrentTargetNote(null)
    currentTargetNoteRef.current = null

    setDistanceCents(null)
    stableMidiRef.current = null
    lastTargetMidiRef.current = null
    targetStartRef.current = null
    attackUntilRef.current = 0

    clearTrail()
  }

  function handleSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const t = parseFloat(e.target.value)
    setCurrentTime(t)
    const p = playerRef.current
    if (!p) return
    p.seekTo(t)
    updatePlayheadPosition()
  }

  function handleTempoChange(mult: number) {
    setTempoMultiplier(mult)
    const p = playerRef.current
    if (!p || !scoreTimeline) return
    p.setTempoMultiplier(mult)
    updatePlayheadPosition()
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
     PITCH LOOP + MATCHING
  ========================= */
  function startDetectLoop() {
    const loop = () => {
      const analyser = analyserRef.current
      const ctx = audioContextRef.current
      const timeline = timelineRef.current
      const player = playerRef.current

      if (!analyser || !ctx) {
        detectTimerRef.current = window.setTimeout(loop, ANALYSIS_INTERVAL_MS)
        return
      }

      const buffer = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(buffer)

      const sr = ctx.sampleRate
      const windowSec = analyser.fftSize / sr
      const halfWindowSec = windowSec / 2

      const rawNow = player?.getCurrentTime() ?? 0
      const correctedNow = rawNow - (latencyMsRef.current || 0) / 1000
      const pitchTime = correctedNow - halfWindowSec

      const voice = selectedVoiceRef.current
      let targetMidi: number | null = null
      let targetStart: number | null = null
      let targetDuration: number | null = null

      if (timeline && voice) {
        const notes = timeline.notes.filter(n => n.voice === voice)

        const active = notes.find(
          n =>
            pitchTime >= n.startTimeSeconds - ACTIVE_TOLERANCE_SEC &&
            pitchTime <= n.startTimeSeconds + n.durationSeconds + ACTIVE_TOLERANCE_SEC
        )

        if (active) {
          targetMidi = active.midiPitch
          targetStart = active.startTimeSeconds
          targetDuration = active.durationSeconds

          const prevTarget = currentTargetNoteRef.current
          const changed = !prevTarget || prevTarget.midi !== targetMidi || prevTarget.start !== targetStart

          if (changed) {
            const newTarget = { voice, midi: targetMidi, start: targetStart, duration: targetDuration }
            currentTargetNoteRef.current = newTarget
            setCurrentTargetNote(newTarget)

            targetStartRef.current = targetStart
            stableMidiRef.current = null

            attackUntilRef.current = pitchTime + ATTACK_PHASE_MS / 1000
            lastTargetMidiRef.current = targetMidi
          }
        } else {
          setCurrentTargetNote(null)
          currentTargetNoteRef.current = null
          targetStartRef.current = null
          lastTargetMidiRef.current = null
          stableMidiRef.current = null
          setDistanceCents(null)
        }
      }

      const result = detectPitch(buffer, sr, targetMidi != null ? { targetMidi } : undefined)
      setPitchResult(result)

      // ==== CENTS + TRAIL ====
      // ==== CENTS + TRAIL ====
      if (result.frequency && targetMidi != null) {
        const noteInfo = frequencyToNoteInfo(result.frequency)
        if (noteInfo) {
          const rawMidi = noteInfo.exactMidi

          // lätt stabilisering (bara lite)
          const prev = stableMidiRef.current
          const stable = prev == null ? rawMidi : prev * 0.85 + rawMidi * 0.15
          stableMidiRef.current = stable

          // RÅA cents (det här är det vi vill VISA i UI)
          const centsRaw =
            1200 * Math.log2(midiToFrequency(stable) / midiToFrequency(targetMidi))

          // Visa alltid råa cents (inga gates som kan "förlåta" allt)
          setDistanceCents(centsRaw)

          // Trail: ignorera attack + kräver clarity
          const inAttack = pitchTime < attackUntilRef.current
          if (!inAttack && result.clarity >= MIN_CLARITY) {
            const abs = Math.abs(centsRaw)

            // Enkel spike-filter för ritning:
            // - kräver 2 mätningar i rad om abs hoppar "för mycket" på en frame
            // - annars rita direkt
            // (vi håller state i refs)
            const lastAbsRef = (startDetectLoop as any)._lastAbsRef ?? { current: 0 }
            const spikeRef = (startDetectLoop as any)._spikeRef ?? { pending: 0, count: 0 }
            ;(startDetectLoop as any)._lastAbsRef = lastAbsRef
            ;(startDetectLoop as any)._spikeRef = spikeRef

            const lastAbs = lastAbsRef.current || 0
            const jump = Math.abs(abs - lastAbs)

            // tröskel: "orimligt stort hopp" (justera gärna)
            const JUMP_CENTS = 120

            if (jump > JUMP_CENTS) {
              // kandidat-spike: kräver bekräftelse
              if (spikeRef.pending === 0 || Math.abs(spikeRef.pending - abs) > 30) {
                spikeRef.pending = abs
                spikeRef.count = 1
              } else {
                spikeRef.count += 1
              }

              // bekräftad i 2 frames -> acceptera och rita
              if (spikeRef.count >= 2) {
                lastAbsRef.current = abs
                spikeRef.pending = 0
                spikeRef.count = 0
                drawTrailMark(abs)
              } else {
                // ignorera denna frame (rita inget)
              }
            } else {
              // normal uppdatering
              spikeRef.pending = 0
              spikeRef.count = 0
              lastAbsRef.current = abs
              drawTrailMark(abs)
            }
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
     RENDER
  ========================= */
  const voicesHuman = getVoices().filter(v => !v.toLowerCase().includes('keyboard'))

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
            {scoreTimeline && (
              <>
                <canvas ref={trailCanvasRef} className="trail-canvas" />
                <div ref={playheadRef} className="playhead-marker" />

                {micActive && isPlaying && currentTargetNote && (
                  <div className="pitch-detector-overlay">
                    <div className="pitch-detector-content">
                      <div className="sung-note">
                        {pitchResult.frequency
                          ? frequencyToNoteInfo(pitchResult.frequency)?.noteName ?? '---'
                          : '---'}
                      </div>
                      <div className="target-note">Mål: {midiToNoteName(currentTargetNote.midi)}</div>
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
        </div>

        <aside className="control-panel">
          <h3>Kontroller</h3>

          {scoreTimeline && (
            <>
              <div className="voice-selection">
                <h4>🎤 Välj stämma att öva</h4>
                <select value={selectedVoice || ''} onChange={e => setSelectedVoice(e.target.value as VoiceId)}>
                  {!selectedVoice && <option value="">Välj stämma...</option>}
                  {voicesHuman.map(v => (
                    <option key={v} value={v}>
                      {buildVoiceDisplayLabel(v, getVoices(), partMetadata)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="player-controls" style={{ marginTop: 16 }}>
                <h4>Spelare</h4>
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
                    <span className="tempo-original"> ({scoreTimeline.tempoBpm} BPM original)</span>
                  </div>
                  <div className="tempo-buttons">
                    {[0.5, 0.75, 1.0, 1.25, 1.5].map(m => (
                      <button key={m} onClick={() => handleTempoChange(m)} className={tempoMultiplier === m ? 'active' : ''}>
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

              <div className="pitch-detector" style={{ marginTop: 16 }}>
                <h4>Tuner</h4>
                <button onClick={handleMicToggle}>{micActive ? 'Stoppa mikrofon' : 'Aktivera mikrofon'}</button>

                {micActive && !isPlaying && (
                  <div className="pitch-display">
                    {pitchResult.frequency ? (
                      <>
                        <div className="pitch-frequency">Frekvens: {pitchResult.frequency.toFixed(1)} Hz</div>
                        <div className="pitch-note">Not: {frequencyToNoteInfo(pitchResult.frequency)?.noteName ?? '---'}</div>
                        <div className="pitch-clarity">Klarhet: {Math.round((pitchResult.clarity ?? 0) * 100)}%</div>
                      </>
                    ) : (
                      <div className="pitch-no-signal">Ingen stabil pitch detekterad</div>
                    )}
                  </div>
                )}
              </div>

              {micActive && (
                <div className="latency-control" style={{ marginTop: 16 }}>
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

              <div className="voice-mixer" style={{ marginTop: 16 }}>
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
                        onChange={e => handleVoiceSettingsChange(v, { volume: parseInt(e.target.value) / 100 })}
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
          )}
        </aside>
      </main>
    </div>
  )
}
