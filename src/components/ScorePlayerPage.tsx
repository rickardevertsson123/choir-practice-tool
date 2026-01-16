/*
 * Copyright (c) 2025 Rickard Evertsson
 */

'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import JSZip from 'jszip'

import { ScoreTimeline, VoiceId } from '../types/ScoreTimeline'
import {
  buildScoreTimelineFromMusicXml,
  extractPartMetadata,
  buildVoiceDisplayLabel,
  PartMetadata
} from '../utils/musicXmlParser'

import { ScorePlayer, VoiceMixerSettings } from '../audio/ScorePlayer'
import { frequencyToNoteInfo, PitchResult, resetPitchDetectorState } from '../audio/pitchDetection'
import { calibrateLatency, calibrateLatencyHeadphones } from '../audio/latencyCalibration'
import { PerfOverlay, PerfSnapshot } from './scorePlayerPage/PerfOverlay'
import { PitchDetectorOverlay } from './scorePlayerPage/PitchDetectorOverlay'
import { TunerPanel } from './scorePlayerPage/TunerPanel'
import { LatencyControl } from './scorePlayerPage/LatencyControl'
import { TransportBar } from './scorePlayerPage/TransportBar'
import { AboutModal } from './scorePlayerPage/AboutModal'

const PITCH_WORKLET_URL = '/worklets/pitchDetector.worklet.js'

/* =========================
  CONSTANTS
========================= */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const FFT_SIZE              = 4096 // 4096 bytes => 93 ms
const ANALYSIS_INTERVAL_MS  = 50   // Periodic analysis
//const MIN_CLARITY           = 0.7  // Pitch gating
//const ORANGE_THRESHOLD_CENTS   = 45;  // When to paint orange (off-pitch)

function midiToNoteName(midi: number): string {
  const noteIndex = ((midi % 12) + 12) % 12
  const octave = Math.floor(midi / 12) - 1
  return NOTE_NAMES[noteIndex] + octave
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

export default function ScorePlayerPage() {
  const router = useRouter()
  const search = useSearchParams()
  // Evaluation mode:
  // - false (default): evaluate pitch vs nearest semitone (raw intonation), no score target note.
  // - true: evaluate vs score target note (requires target selection code below).
  const USE_TARGET_NOTE = String(process.env.NEXT_PUBLIC_USE_TARGET_NOTE ?? 'false').toLowerCase() === 'true'

  // Async transition gate + debug overlay
  const ENABLE_ASYNC_TRANSITION =
    String(process.env.NEXT_PUBLIC_ENABLE_ASYNC_TRANSITION ?? 'true').toLowerCase() !== 'false'
  const SHOW_PITCH_DEBUG = String(process.env.NEXT_PUBLIC_PITCH_DEBUG ?? 'false').toLowerCase() === 'true'

  // Allowed score notes window (for "note correctness" without hinting pitch detection).
  // We compare the *nearest semitone* (rounded MIDI) against all target notes within this window.
  const ALLOWED_TARGET_WINDOW_SEC = Number(process.env.NEXT_PUBLIC_ALLOWED_TARGET_WINDOW_SEC ?? '0.25')

  type Difficulty = 'normal' | 'advanced' | 'expert';

  type PitchSettings = {
    MIN_CLARITY: number;
    ORANGE_THRESHOLD_CENTS: number;
  };

  const DIFFICULTY_PRESETS_NEAREST_SEMITONE: Record<Difficulty, PitchSettings> = {
    // Keep these above typical vibrato (~±15 cents) so vibrato doesn't paint red.
    normal:   { MIN_CLARITY: 0.85, ORANGE_THRESHOLD_CENTS: 90 },
    advanced: { MIN_CLARITY: 0.85, ORANGE_THRESHOLD_CENTS: 50 },
    expert:   { MIN_CLARITY: 0.75, ORANGE_THRESHOLD_CENTS: 20 },
  }

  const DIFFICULTY_PRESETS: Record<Difficulty, PitchSettings> = DIFFICULTY_PRESETS_NEAREST_SEMITONE

  const pitchSettingsRef = useRef<PitchSettings>(DIFFICULTY_PRESETS_NEAREST_SEMITONE.normal);


  /* =========================
     REFS: DOM / OSMD
  ========================= */
  const scoreContainerRef = useRef<HTMLDivElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null)
  const osmdContainerRef = useRef<HTMLDivElement | null>(null)

  const trailCanvasRef = useRef<HTMLCanvasElement>(null)
  const trailCtxRef = useRef<CanvasRenderingContext2D | null>(null)

  /* =========================
     REFS: OSMD cursor mapping + position cache
  ========================= */
  const cursorStepsRef = useRef<Array<{ step: number; musicalTime: number }>>([])
  const cursorPositionsRef = useRef<Array<{ step: number; left: number; top: number; height: number }>>([])
  const positionsReadyRef = useRef(false)

  /* =========================
     REFS: PLAYER / TIMELINE
  ========================= */
  const playerRef = useRef<ScorePlayer | null>(null)
  const timelineRef = useRef<ScoreTimeline | null>(null)

  /* =========================
     REFS: AUDIO / MIC
  ========================= */
  const audioContextRef = useRef<AudioContext | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const pitchWorkletNodeRef = useRef<AudioWorkletNode | null>(null)
  const pitchWorkletTapGainRef = useRef<GainNode | null>(null)
  const useWorkletRef = useRef(false)
  const notesByVoiceRef = useRef<Record<string, Array<{ midi: number; start: number; end: number; duration: number }>> | null>(null)
  const notesIndexByVoiceRef = useRef<Record<string, number>>({})
  // Performance counters
  const perfIterationsRef = useRef(0)
  const perfTotalLoopMsRef = useRef(0)
  const perfMinLoopMsRef = useRef<number>(Infinity)
  const perfMaxLoopMsRef = useRef(0)
  const perfLastLoopMsRef = useRef(0)
  const perfTotalDetectMsRef = useRef(0)
  const perfMinDetectMsRef = useRef<number>(Infinity)
  const perfMaxDetectMsRef = useRef(0)
  const perfLastDetectMsRef = useRef(0)
  const perfSkippedRef = useRef(0)
  const perfLastConsoleMsRef = useRef(0)
  const [perfSnapshot, setPerfSnapshot] = useState<PerfSnapshot | null>(null)

  /* =========================
     REFS: PITCH
  ========================= */
  // Asynchronous transition detection (no explicit time window):
  // We only look at two consecutive analyses (prev -> current), but we use
  // hysteresis thresholds so we don't flap between stable/transition:
  // - enter transition if delta > START
  // - exit transition if delta < STOP
  const transitionRef = useRef<{
    lastExactMidi: number | null
    inTransition: boolean
  }>({
    lastExactMidi: null,
    inTransition: false
  })

  // Trail throttling
  const TRAIL_MAX_HZ = 25
  const TRAIL_MIN_DX_PX = 1.5
  const lastTrailDrawMsRef = useRef<number>(0)
  const lastTrailXRef = useRef<number | null>(null)

  // Trail confirmation gate: require consecutive frames before drawing.
  // - offPitch (orange): 2 frames
  // - wrongNote (red): 3 frames (more strict, avoids transient consonant/attack mislabels)
  const trailConfirmRef = useRef<{
    count: number
    confirmed: boolean
    lastKind: 'offPitch' | 'wrongNote' | null
  }>({
    count: 0,
    confirmed: false,
    lastKind: null
  })

  // Console debug throttling (so VITE_PITCH_DEBUG doesn't spam too hard).
  const lastPitchDebugLogRef = useRef<{ lastMs: number; lastMsg: string }>({ lastMs: 0, lastMsg: '' })

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

  const [latencyMs, setLatencyMs] = useState(150)
  const latencyMsRef = useRef(latencyMs)

  const [calibrating, setCalibrating] = useState(false)
  const [calibrationMessage, setCalibrationMessage] = useState<string | null>(null)
  

  const [currentTargetNote, setCurrentTargetNote] = useState<{
    voice: VoiceId
    midi: number
    start: number
    duration: number
  } | null>(null)
  const currentTargetNoteRef = useRef<typeof currentTargetNote>(null)

  const [distanceCents, setDistanceCents] = useState<number | null>(null)

  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [aboutOpen, setAboutOpen] = useState(false)

  // Avoid unnecessary rerenders from the detect loop by only committing
  // user-visible changes (rounded values) to React state.
  const lastEmittedPitchRef = useRef<PitchResult | null>(null)
  const lastEmittedDistanceRoundedRef = useRef<number | null>(null)

  /* =========================
     Pitch User Levels
  ========================= */
  useEffect(() => {
    pitchSettingsRef.current = DIFFICULTY_PRESETS[difficulty];
  }, [difficulty]);
  /* =========================
     SYNC REFS
  ========================= */
  useEffect(() => {
    selectedVoiceRef.current = selectedVoice
  }, [selectedVoice])

  useEffect(() => {
    currentTargetNoteRef.current = currentTargetNote
  }, [currentTargetNote])

  useEffect(() => {
    latencyMsRef.current = latencyMs
  }, [latencyMs])

  /* =========================
     OSMD INIT
  ========================= */
  useEffect(() => {
    // Initialize OSMD in a dedicated inner container so React doesn't also
    // manage the same child nodes. Mixing React-managed children with
    // third-party DOM mutations causes "removeChild" errors during
    // reconciliation.
    if (!osmdContainerRef.current || osmdRef.current) return
    try {
      osmdRef.current = new OpenSheetMusicDisplay(osmdContainerRef.current, {
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

  /* =========================
     CANVAS INIT
  ========================= */
  useEffect(() => {
    if (!trailCanvasRef.current || !scoreContainerRef.current) return
    const canvas = trailCanvasRef.current
    const container = scoreContainerRef.current

    canvas.width = Math.max(1, container.scrollWidth || container.clientWidth || 1)
    canvas.height = Math.max(1, container.scrollHeight || container.clientHeight || 1)

    trailCtxRef.current = canvas.getContext('2d')
  }, [scoreTimeline])

  function clearTrail() {
    const ctx = trailCtxRef.current
    const canvas = trailCanvasRef.current
    lastTrailDrawMsRef.current = 0
    lastTrailXRef.current = null
    if (!ctx || !canvas) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  function clearTrailToRightOfPlayhead() {
    const ctx = trailCtxRef.current
    const canvas = trailCanvasRef.current
    const playhead = playheadRef.current
    if (!ctx || !canvas || !playhead) return

    const left = parseFloat(playhead.style.left || '0')
    if (!Number.isFinite(left)) return

    const x = Math.max(0, Math.min(canvas.width, left + 1))
    ctx.clearRect(x, 0, canvas.width - x, canvas.height)
  }

  const drawTrailAtPlayhead = (absCents: number, kind: 'offPitch' | 'wrongNote' = 'offPitch') => {
    if (!positionsReadyRef.current) return
    const S = pitchSettingsRef.current;
    const ctx = trailCtxRef.current
    const canvas = trailCanvasRef.current
    const playhead = playheadRef.current
    const container = scoreContainerRef.current
    if (!ctx || !canvas || !playhead || !container) return

    if (absCents < S.ORANGE_THRESHOLD_CENTS) return

    const nowMs = performance.now()
    const minIntervalMs = 1000 / TRAIL_MAX_HZ
    if (nowMs - lastTrailDrawMsRef.current < minIntervalMs) return

    const left = parseFloat(playhead.style.left || '0')
    const top = parseFloat(playhead.style.top || '0')
    const height = parseFloat(playhead.style.height || '0')

    if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return

    const lastX = lastTrailXRef.current
    if (lastX != null && Math.abs(left - lastX) < TRAIL_MIN_DX_PX) return

    lastTrailDrawMsRef.current = nowMs
    lastTrailXRef.current = left

    const effectiveCents = Math.max(0, absCents - S.ORANGE_THRESHOLD_CENTS);
    const alpha = clamp(effectiveCents / 100, 0, 0.3)
    // Orange = off pitch, Red = wrong note (not in allowed score window)
    ctx.fillStyle = kind === 'wrongNote'
      ? `rgba(239, 68, 68, ${alpha})`
      : `rgba(249, 115, 22, ${alpha})`
    ctx.fillRect(left, top, 6, height)
  }

  /* =========================
     FILE LOAD
  ========================= */
  const lastLoadedUrlRef = useRef<string | null>(null)

  async function loadXmlContent(xmlContent: string) {
    if (!osmdRef.current) throw new Error('OSMD saknas')
    await osmdRef.current.load(xmlContent)
    await osmdRef.current.render()

    osmdRef.current.cursor.show()
    osmdRef.current.cursor.reset()

    const steps: Array<{ step: number; musicalTime: number }> = []
    let i = 0
    while (!osmdRef.current.cursor.Iterator.EndReached) {
      const ts = osmdRef.current.cursor.Iterator.CurrentSourceTimestamp
      steps.push({ step: i, musicalTime: ts ? ts.RealValue : 0 })
      osmdRef.current.cursor.next()
      i++
    }
    cursorStepsRef.current = steps

    osmdRef.current.cursor.reset()
    osmdRef.current.cursor.update()

    const metadata = extractPartMetadata(xmlContent)
    setPartMetadata(metadata)

    const timeline = await buildScoreTimelineFromMusicXml(xmlContent)
    timelineRef.current = timeline
    setScoreTimeline(timeline)
    setCurrentTime(0)

    // Precompute notes grouped by voice to avoid rebuilding per-detection tick
    const map: Record<string, Array<{ midi: number; start: number; end: number; duration: number }>> = {}
    for (const n of timeline.notes) {
      if (!map[n.voice]) map[n.voice] = []
      map[n.voice].push({ midi: n.midiPitch, start: n.startTimeSeconds, end: n.startTimeSeconds + n.durationSeconds, duration: n.durationSeconds })
    }
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => a.start - b.start)
    }
    notesByVoiceRef.current = map
    // initialize per-voice indices
    const idxMap: Record<string, number> = {}
    for (const k of Object.keys(map)) idxMap[k] = 0
    notesIndexByVoiceRef.current = idxMap

    clearTrail()

    // Reset pitch-detector internals and page-level pitch evaluation state so
    // that loading a new file doesn't leave remnants from the previous song
    // (spike gate, pending jumps, stable midi, transition grace, etc.).
    resetPitchDetectorState()
    resetPitchEvaluationState()

    // Build the position cache and wait for it to become ready before
    // restarting detection. `buildPositionCache` waits one animation frame
    // to ensure OSMD has painted its cursor elements.
    await buildPositionCache()

    const voices = Array.from(new Set(timeline.notes.map(n => n.voice))).filter(
      v => !v.toLowerCase().includes('keyboard')
    )
    // Ensure selected voice is valid for the new timeline. If the previous
    // selection doesn't exist in the newly loaded score, pick the first.
    if (voices.length) {
      if (!selectedVoice || !voices.includes(selectedVoice)) setSelectedVoice(voices[0])
    } else {
      setSelectedVoice(null)
    }

    // If mic is active, restart detection loop after we've rebuilt timeline
    // and indices. Give a short delay to allow player and caches to initialize.
    if (micActive) {
      // restart detection only after positions are ready
      resetPitchDetectorState()
      resetPitchEvaluationState()
    }
  }

  async function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setError('')
    setIsLoading(true)

    try {
      const xmlContent = await readFile(file)
      await loadXmlContent(xmlContent)
    } catch (err: any) {
      console.error(err)
      setError(`Kunde inte ladda filen: ${err?.message ?? 'Okänt fel'}`)
    } finally {
      setIsLoading(false)
    }
  }

  async function readUrlAsXml(url: string): Promise<string> {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`Failed to fetch score (HTTP ${r.status})`)
    const blob = await r.blob()

    // Try to infer filename from URL.
    const u = new URL(url)
    const last = u.pathname.split('/').pop() || 'score'
    const name = decodeURIComponent(last.split('?')[0])

    if (!name.toLowerCase().endsWith('.mxl')) {
      return await blob.text()
    }

    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
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

  useEffect(() => {
    const scoreUrl = search?.get('scoreUrl')
    if (!scoreUrl) return
    if (lastLoadedUrlRef.current === scoreUrl) return

    lastLoadedUrlRef.current = scoreUrl
    setError('')
    setIsLoading(true)
    readUrlAsXml(scoreUrl)
      .then((xml) => loadXmlContent(xml))
      .catch((err: any) => {
        console.error(err)
        setError(`Kunde inte ladda scoreUrl: ${err?.message ?? 'Okänt fel'}`)
      })
      .finally(() => setIsLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

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
      // Pass existing audio context when available so the player shares the
      // same context as the mic (avoids multiple contexts and timing mismatch).
      // @ts-ignore
      playerRef.current = new ScorePlayer(scoreTimeline, { partMetadata, audioContext: audioContextRef.current })
      timelineRef.current = scoreTimeline

      const initialSettings: Record<VoiceId, VoiceMixerSettings> = {}
      const voices = Array.from(new Set(scoreTimeline.notes.map(n => n.voice)))
      for (const v of voices) {
        initialSettings[v] = playerRef.current.getVoiceSettings(v)
      }
      setVoiceSettings(initialSettings)
    } catch (err) {
      console.error(err)
      setError('Could not initialize audio player.')
    }

    return () => {
      if (playerRef.current) {
        playerRef.current.dispose()
        playerRef.current = null
      }
    }
  }, [scoreTimeline, partMetadata])

  /* =========================
     PLAYER TIME TICK + LOOP END SAFE
  ========================= */
  useEffect(() => {
    if (!scoreTimeline) return

    const id = window.setInterval(() => {
      const p = playerRef.current
      if (!p) return
      const t = p.getCurrentTime()
      setCurrentTime(t)
      setIsPlaying(p.isPlaying())

      if (p.isPlaying() && t >= scoreTimeline.totalDurationSeconds - 0.02) {
        // Auto-loop: restart immediately from the beginning.
        // Trail is cleared on auto-loop so each loop is a fresh "take".
        clearTrail()
        resetPitchEvaluationState()
        resetPitchDetectorState()
        setCurrentTargetNote(null)
        currentTargetNoteRef.current = null
        setDistanceCents(null)
        lastEmittedDistanceRoundedRef.current = null
        lastEmittedPitchRef.current = null

        p.seekTo(0)
        setCurrentTime(0)
        setIsPlaying(true)
      }
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
      const dur = scoreTimeline?.totalDurationSeconds ?? p.getDuration()
      const t = p.getCurrentTime()
      const atEnd = dur > 0 && t >= dur - 0.02

      if (atEnd) {
        // Intuitive behavior: if we're paused at the end, pressing Play should
        // restart from the beginning. Clear the full trail only now (on Play),
        // so the user can review the colored notes after finishing.
        clearTrail()
        resetPitchEvaluationState()
        p.seekTo(0)
        setCurrentTime(0)
      } else {
        // Clear everything ahead of the playhead so only the already-sung section
        // remains visible. (Keeps the trail for review after playback ends.)
        clearTrailToRightOfPlayhead()
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
    lastEmittedDistanceRoundedRef.current = null
    lastEmittedPitchRef.current = null

    clearTrail()

    if (osmdRef.current) {
      osmdRef.current.cursor.reset()
      osmdRef.current.cursor.update()
    }

    resetPitchEvaluationState();
    // Keep detect loop running while mic is active (tuner should still work).
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
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        })
      } catch (e: any) {
        // Provide the real browser error (NotAllowedError, NotFoundError, NotReadableError, etc.)
        console.error('[mic] getUserMedia failed', e)
        const name = e?.name ? String(e.name) : 'UnknownError'
        const msg = e?.message ? String(e.message) : ''
        setError(`Microphone error: ${name}${msg ? ` - ${msg}` : ''}`)
        return
      }
      micStreamRef.current = stream

      if (!audioContextRef.current) audioContextRef.current = new AudioContext()

      const source = audioContextRef.current.createMediaStreamSource(stream)
      const ctx = audioContextRef.current

      // CRITICAL: keep playback and mic/worklet on the same AudioContext clock.
      // If ScorePlayer was created before the mic (audioContextRef.current was null),
      // it will have created its own AudioContext, which breaks worklet timestamp
      // alignment and makes target selection wrong.
      const existingPlayer = playerRef.current
      if (existingPlayer && scoreTimeline) {
        try {
          const playerCtx = existingPlayer.getAudioContext()
          if (playerCtx !== ctx) {
            const wasPlaying = existingPlayer.isPlaying()
            const t = existingPlayer.getCurrentTime()
            existingPlayer.dispose()
            // Recreate on the shared context
            // @ts-ignore
            playerRef.current = new ScorePlayer(scoreTimeline, { partMetadata, audioContext: ctx })
            timelineRef.current = scoreTimeline

            // Refresh mixer state from new player instance
            const initialSettings: Record<VoiceId, VoiceMixerSettings> = {}
            const voices = Array.from(new Set(scoreTimeline.notes.map(n => n.voice)))
            for (const v of voices) {
              initialSettings[v] = playerRef.current.getVoiceSettings(v)
            }
            setVoiceSettings(initialSettings)

            // Restore time/play state (best-effort; avoids user-visible jumps)
            playerRef.current.seekTo(t)
            if (wasPlaying) playerRef.current.play()
          }
        } catch (e) {
          console.warn('[audio] failed to rebind ScorePlayer to mic AudioContext', e)
        }
      }

      // Pitch detection is AudioWorklet-only (no Analyser/polling fallback).
      useWorkletRef.current = false
      if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') {
        throw new Error('AudioWorklet stöds inte i denna webbläsare (krävs).')
      }

      try {
        await ctx.audioWorklet.addModule(PITCH_WORKLET_URL)

        const node = new AudioWorkletNode(ctx, 'pitch-detector', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { windowSize: FFT_SIZE, analysisIntervalMs: ANALYSIS_INTERVAL_MS }
        })

        // Ensure the node is "pulled" by the graph but keep it silent.
        const tap = ctx.createGain()
        tap.gain.value = 0

        source.connect(node)
        node.connect(tap)
        tap.connect(ctx.destination)

        pitchWorkletNodeRef.current = node
        pitchWorkletTapGainRef.current = tap
        useWorkletRef.current = true
      } catch (e) {
        console.warn('[pitch] audioWorklet init failed', e, 'workletUrl=', PITCH_WORKLET_URL)
        throw new Error('Kunde inte starta AudioWorklet (krävs).')
      }

      setMicActive(true)

      setPitchResult({ frequency: null, clarity: 0 })
      setDistanceCents(null)

      // reset pitch detection internal gate too
      resetPitchDetectorState()

      // Start detection:
      // - worklet mode is event-driven (port messages)
      if (useWorkletRef.current && pitchWorkletNodeRef.current) {
        pitchWorkletNodeRef.current.port.onmessage = (ev: MessageEvent<any>) => {
          const handlerStartMs = performance.now()
          const data = ev.data
          if (!data || typeof data !== 'object') return
          if (data.type !== 'pitch') return

          const player = playerRef.current
          const timeline = timelineRef.current
          const voice = selectedVoiceRef.current
          const S = pitchSettingsRef.current

          const halfWindowSec =
            typeof data.halfWindowSec === 'number'
              ? data.halfWindowSec
              : ((FFT_SIZE / (audioContextRef.current?.sampleRate ?? 44100)) / 2)

          const audioTimeSec = typeof data.audioTimeSec === 'number' ? data.audioTimeSec : null

          // IMPORTANT: Worklet timestamps are in AudioContext time (real seconds).
          // We want to align the *center* of the analysis window with playback
          // timeline time. Convert AudioContext seconds -> timeline seconds,
          // then apply latency compensation in timeline seconds.
          //
          // This avoids mixing time bases (audio seconds vs timeline seconds),
          // which would otherwise drift and make target selection wrong.
          const analysisCenterAudioTimeSec =
            audioTimeSec != null ? Math.max(0, audioTimeSec - halfWindowSec) : null

          const rawNowScoreTime =
            analysisCenterAudioTimeSec != null && player
              ? player.getTimeAtAudioContextTime(analysisCenterAudioTimeSec)
              : (player?.getCurrentTime() ?? 0)

          // Score-time used for any "compare to score" logic (does not affect pitch detection).
          const pitchTime = rawNowScoreTime - (latencyMsRef.current || 0) / 1000

          // Optional: target-note selection from the score timeline.
          // (Kept for later re-enable, but disabled by default for "raw pitchy" evaluation.)
          if (USE_TARGET_NOTE) {
            // --- TARGET SELECTION (single target only; no transition window) ---
            let target: { midi: number; start: number; duration: number } | null = null
            const currentTarget = currentTargetNoteRef.current

            if (timeline && voice) {
              const notes = notesByVoiceRef.current?.[voice] ?? []
              const idxMap = notesIndexByVoiceRef.current
              if (!(voice in idxMap)) idxMap[voice] = 0
              let currentIdx = idxMap[voice]

              if (currentIdx < 0) currentIdx = 0
              if (currentIdx >= notes.length) currentIdx = Math.max(0, notes.length - 1)

              while (currentIdx < notes.length && pitchTime >= notes[currentIdx].end) currentIdx++
              while (currentIdx > 0 && pitchTime < notes[currentIdx].start) currentIdx--
              if (currentIdx >= notes.length) currentIdx = notes.length - 1
              idxMap[voice] = currentIdx
              if (notes.length === 0 || pitchTime < notes[0].start) currentIdx = -1

              if (currentIdx >= 0) {
                const cur = notes[currentIdx]
                target = { midi: cur.midi, start: cur.start, duration: cur.duration }
              }

              if (target) {
                if (!currentTarget || currentTarget.midi !== target.midi) {
                  const next = { voice, midi: target.midi, start: target.start, duration: target.duration }
                  currentTargetNoteRef.current = next
                  setCurrentTargetNote(next)
                }
              } else {
                if (currentTarget) {
                  currentTargetNoteRef.current = null
                  setCurrentTargetNote(null)
                }
              }
            } else {
              if (currentTarget) {
                currentTargetNoteRef.current = null
                setCurrentTargetNote(null)
              }
            }
          } else {
            // In "nearest semitone" mode we don't use score targets.
            if (currentTargetNoteRef.current) {
              currentTargetNoteRef.current = null
              setCurrentTargetNote(null)
            }
          }

          // --- PITCH RESULT + CENTS/JUDGEMENT (reuse existing page logic) ---
          const result = { frequency: data.frequency ?? null, clarity: data.clarity ?? 0 } as PitchResult

          
          // Throttle UI state updates so we don't rerender on every worklet tick.
          //const lastPitch = lastEmittedPitchRef.current
          //const nextHz10 = result.frequency != null ? Math.round(result.frequency * 10) : null
          //const lastHz10 = lastPitch?.frequency != null ? Math.round(lastPitch.frequency * 10) : null
          //const nextClarityPct = Math.round((result.clarity ?? 0) * 100)
          //const lastClarityPct = Math.round(((lastPitch?.clarity ?? 0)) * 100)
          //if (nextHz10 !== lastHz10 || nextClarityPct !== lastClarityPct) {
          //  lastEmittedPitchRef.current = result
          //  setPitchResult(result)
          //}
          const isStableSignal = result.frequency != null && result.clarity >= S.MIN_CLARITY

          const uiTarget = currentTargetNoteRef.current
          if (isStableSignal && result.frequency != null) {
            const noteInfo = frequencyToNoteInfo(result.frequency)
            const exactMidi = noteInfo?.exactMidi ?? null
            const nearestMidi = exactMidi != null ? Math.round(exactMidi) : null

            // Build allowed target set within a small time window around pitchTime.
            // This is "note correctness" only (no hinting of pitch detection).
            let isAllowedNoteInWindow = true
            // Debug helper: when we flag "note not in window", capture which notes were in the window.
            let debugWindowMidis: number[] | null = null
            let debugWindowStartT: number | null = null
            let debugWindowEndT: number | null = null
            let debugClosestAllowed: { midi: number; distCents: number } | null = null
            let closestAllowedDistCents: number | null = null
            let nearMissOfAllowed = false
            if (timeline && voice && Number.isFinite(ALLOWED_TARGET_WINDOW_SEC) && ALLOWED_TARGET_WINDOW_SEC > 0) {
              const notes = notesByVoiceRef.current?.[voice] ?? []
              if (notes.length > 0 && nearestMidi != null) {
                const startT = pitchTime - ALLOWED_TARGET_WINDOW_SEC
                const endT = pitchTime + ALLOWED_TARGET_WINDOW_SEC
                debugWindowStartT = startT
                debugWindowEndT = endT

                const idxMap = notesIndexByVoiceRef.current
                if (!(voice in idxMap)) idxMap[voice] = 0
                let i = idxMap[voice]
                if (i < 0) i = 0
                if (i >= notes.length) i = Math.max(0, notes.length - 1)

                while (i < notes.length && pitchTime >= notes[i].end) i++
                while (i > 0 && pitchTime < notes[i].start) i--
                if (i >= notes.length) i = notes.length - 1
                idxMap[voice] = i

                let left = i
                while (left > 0 && notes[left - 1].end >= startT) left--
                let right = i
                while (right < notes.length && notes[right].start <= endT) right++

                isAllowedNoteInWindow = false
                let closestCents = Infinity
                let closestMidi: number | null = null
                for (let k = left; k < right; k++) {
                  const n = notes[k]
                  if (n.end < startT || n.start > endT) continue
                  if (exactMidi != null) {
                    const dc = Math.abs((exactMidi - n.midi) * 100)
                    if (dc < closestCents) {
                      closestCents = dc
                      closestMidi = n.midi
                    }
                  }
                  if (n.midi === nearestMidi) {
                    isAllowedNoteInWindow = true
                    break
                  }
                }

                if (SHOW_PITCH_DEBUG && closestMidi != null && Number.isFinite(closestCents)) {
                  debugClosestAllowed = { midi: closestMidi, distCents: closestCents }
                }
                if (closestMidi != null && Number.isFinite(closestCents)) {
                  closestAllowedDistCents = closestCents
                }

                nearMissOfAllowed =
                  !isAllowedNoteInWindow &&
                  typeof closestAllowedDistCents === 'number' &&
                  Number.isFinite(closestAllowedDistCents) &&
                  closestAllowedDistCents < 90

                if (SHOW_PITCH_DEBUG && !isAllowedNoteInWindow) {
                  debugWindowMidis = []
                  for (let k = left; k < right && debugWindowMidis.length < 10; k++) {
                    const n = notes[k]
                    if (n.end < startT || n.start > endT) continue
                    if (!debugWindowMidis.includes(n.midi)) debugWindowMidis.push(n.midi)
                  }
                }
              }
            }

            let inAsyncTransition = false
            if (ENABLE_ASYNC_TRANSITION) {
              // --- ASYNC TRANSITION DETECTION ---
              // Vibrato guidance: 4–6 Hz with ±15 cents means per-50ms tick deltas are
              // usually below ~30 cents. We set thresholds above that so vibrato doesn't
              // trigger transition mode.
              const TRANSITION_START_CENTS = 50
              const TRANSITION_STOP_CENTS = 30
              const prevExact = transitionRef.current.lastExactMidi
              const prevInTransition = transitionRef.current.inTransition

              // Update history for next tick (after we've captured prevExact above)
              if (exactMidi != null) transitionRef.current.lastExactMidi = exactMidi

              if (exactMidi == null || prevExact == null) {
                // If we don't have enough info, treat as unstable for judgement.
                transitionRef.current.inTransition = true
                inAsyncTransition = true
              } else {
                const deltaCents = Math.abs((exactMidi - prevExact) * 100)

                // Hysteresis: larger threshold to enter transition, smaller to exit.
                if (prevInTransition) {
                  if (deltaCents < TRANSITION_STOP_CENTS) {
                    transitionRef.current.inTransition = false
                    inAsyncTransition = false
                  } else {
                    transitionRef.current.inTransition = true
                    inAsyncTransition = true
                  }
                } else {
                  if (deltaCents > TRANSITION_START_CENTS) {
                    transitionRef.current.inTransition = true
                    inAsyncTransition = true
                  } else {
                    transitionRef.current.inTransition = false
                    inAsyncTransition = false
                  }
                }
              }
            }

            const cents = !inAsyncTransition && exactMidi != null
              ? (USE_TARGET_NOTE && uiTarget
                  ? (exactMidi - uiTarget.midi) * 100
                  : (exactMidi - Math.round(exactMidi)) * 100)
              : null

            const lastRounded = lastEmittedDistanceRoundedRef.current
            const nextRounded = cents == null ? null : Math.round(cents)
            if (nextRounded !== lastRounded) {
              lastEmittedDistanceRoundedRef.current = nextRounded
              setDistanceCents(cents)
            }

            if (player?.isPlaying() && cents != null) {
              const trailKind: 'offPitch' | 'wrongNote' =
                (!isAllowedNoteInWindow && !nearMissOfAllowed) ? 'wrongNote' : 'offPitch'

              // If we're extremely far from the closest allowed note (e.g. ~octave/subharmonic glitch),
              // don't draw purple/red at all for that frame.
              const isHugeMismatch =
                !isAllowedNoteInWindow &&
                typeof closestAllowedDistCents === 'number' &&
                Number.isFinite(closestAllowedDistCents) &&
                closestAllowedDistCents >= 1000

              const abs =
                // If sung note isn't allowed, but it's close to some allowed note center, treat it as intonation.
                nearMissOfAllowed
                  ? closestAllowedDistCents!
                  : (!isAllowedNoteInWindow
                      // Otherwise treat as "wrong note" for score marking (even if cents≈0).
                      ? (S.ORANGE_THRESHOLD_CENTS + 100)
                      : Math.abs(cents))

              if (isHugeMismatch) {
                // Treat as unreliable frame; reset confirmation and skip drawing.
                trailConfirmRef.current.count = 0
                trailConfirmRef.current.confirmed = false
                trailConfirmRef.current.lastKind = null
              } else if (abs >= S.ORANGE_THRESHOLD_CENTS) {
                // Require consecutive frames before we start drawing.
                const required = trailKind === 'wrongNote' ? 3 : 2
                if (trailConfirmRef.current.lastKind !== trailKind) {
                  trailConfirmRef.current.lastKind = trailKind
                  trailConfirmRef.current.count = 0
                  trailConfirmRef.current.confirmed = false
                }
                if (!trailConfirmRef.current.confirmed) {
                  trailConfirmRef.current.count += 1
                  if (trailConfirmRef.current.count >= required) {
                    trailConfirmRef.current.confirmed = true
                    drawTrailAtPlayhead(abs, trailKind)
                  }
                } else {
                  drawTrailAtPlayhead(abs, trailKind)
                }
              } else {
                trailConfirmRef.current.count = 0
                trailConfirmRef.current.confirmed = false
                trailConfirmRef.current.lastKind = null
              }
            }

            if (SHOW_PITCH_DEBUG) {
              const reason =
                exactMidi == null
                  ? 'noteInfo null'
                  : (ENABLE_ASYNC_TRANSITION && inAsyncTransition
                      ? 'transition'
                      : (!isAllowedNoteInWindow && !nearMissOfAllowed
                          ? (() => {
                              const sung = nearestMidi != null ? `${midiToNoteName(nearestMidi)}(${nearestMidi})` : 'unknown'
                              const allowed =
                                debugWindowMidis && debugWindowMidis.length
                                  ? debugWindowMidis.map(m => `${midiToNoteName(m)}(${m})`).join(', ')
                                  : 'none'
                              const closest =
                                debugClosestAllowed
                                  ? `${midiToNoteName(debugClosestAllowed.midi)}(${debugClosestAllowed.midi})@${debugClosestAllowed.distCents.toFixed(0)}c`
                                  : 'unknown'
                              const win =
                                debugWindowStartT != null && debugWindowEndT != null
                                  ? `${debugWindowStartT.toFixed(2)}..${debugWindowEndT.toFixed(2)}`
                                  : '?'
                              return `note not in window; sung=${sung}; closest=${closest}; allowed=[${allowed}]; win=${win}`
                            })()
                          : (!isAllowedNoteInWindow && nearMissOfAllowed
                              ? (() => {
                                  const sung = nearestMidi != null ? `${midiToNoteName(nearestMidi)}(${nearestMidi})` : 'unknown'
                                  const closest =
                                    debugClosestAllowed
                                      ? `${midiToNoteName(debugClosestAllowed.midi)}(${debugClosestAllowed.midi})@${debugClosestAllowed.distCents.toFixed(0)}c`
                                      : 'unknown'
                                  return `near miss (treat as intonation); sung=${sung}; closest=${closest}`
                                })()
                              : null)))
              // Always show something when debug is enabled so it's obvious the flag is active.
              result.debugReason = reason ?? 'ok'

              // Console logging for "wrong note" cases (purple trail) since overlay is hard to read.
              if (typeof result.debugReason === 'string' && result.debugReason.startsWith('note not in window')) {
                const nowMs = performance.now()
                const last = lastPitchDebugLogRef.current
                // Throttle: max ~2 logs/sec and avoid repeating identical lines.
                if (nowMs - last.lastMs > 200 && result.debugReason !== last.lastMsg) {
                  lastPitchDebugLogRef.current = { lastMs: nowMs, lastMsg: result.debugReason }
                  const hz = result.frequency != null ? result.frequency.toFixed(1) : 'null'
                  const c = typeof cents === 'number' ? cents.toFixed(1) : 'null'
                  // Expected score note at pitchTime (single-note view) for context.
                  let expected: string = 'unknown'
                  let expectedDelta: string = 'unknown'
                  try {
                    if (voice) {
                      const notes = notesByVoiceRef.current?.[voice] ?? []
                      if (notes.length > 0) {
                        // Find current note at pitchTime (best-effort, O(1) amortized using idx map)
                        const idxMap = notesIndexByVoiceRef.current
                        if (!(voice in idxMap)) idxMap[voice] = 0
                        let i = idxMap[voice]
                        if (i < 0) i = 0
                        if (i >= notes.length) i = Math.max(0, notes.length - 1)
                        while (i < notes.length && pitchTime >= notes[i].end) i++
                        while (i > 0 && pitchTime < notes[i].start) i--
                        if (i >= notes.length) i = notes.length - 1
                        idxMap[voice] = i
                        const n = notes[i]
                        if (pitchTime >= n.start && pitchTime < n.end) {
                          expected = `${midiToNoteName(n.midi)}(${n.midi})`
                          if (exactMidi != null) expectedDelta = `${((exactMidi - n.midi) * 100).toFixed(0)}c`
                        }
                      }
                    }
                  } catch {}
                  console.log(
                    `[pitch-debug] ${result.debugReason}; expected=${expected}; expectedDelta=${expectedDelta}; voice=${String(voice ?? 'null')}; hz=${hz}; cents=${c}; clarity=${Math.round((result.clarity ?? 0) * 100)}%; pitchTime=${pitchTime.toFixed(3)}`
                  )
                }
              }
            } else {
              result.debugReason = null
            }
          } else {
            // No freeze: if signal is unstable or no target, clear distance.
            if (lastEmittedDistanceRoundedRef.current !== null) {
              lastEmittedDistanceRoundedRef.current = null
              setDistanceCents(null)
            }

            // Unstable/transition/no-frequency: reset confirmation so we don't
            // "carry over" an off-pitch spike across gaps.
            trailConfirmRef.current.count = 0
            trailConfirmRef.current.confirmed = false
            trailConfirmRef.current.lastKind = null

            if (SHOW_PITCH_DEBUG) {
              const reason =
                result.frequency == null ? 'frequency null' : (result.clarity < S.MIN_CLARITY ? 'low clarity' : null)
              result.debugReason = reason ?? 'ok'
            } else {
              result.debugReason = null
            }
          }

          // Unthrottled UI update (you chose to keep it that way for now)
          setPitchResult(result)

          // --- PERF: update counters from worklet messages ---
          const handlerEndMs = performance.now()
          const loopMs = handlerEndMs - handlerStartMs
          perfLastLoopMsRef.current = loopMs
          perfTotalLoopMsRef.current += loopMs
          perfIterationsRef.current += 1
          if (loopMs < perfMinLoopMsRef.current) perfMinLoopMsRef.current = loopMs
          if (loopMs > perfMaxLoopMsRef.current) perfMaxLoopMsRef.current = loopMs

          const detectMs = typeof data.detectMs === 'number' ? data.detectMs : 0
          perfLastDetectMsRef.current = detectMs
          perfTotalDetectMsRef.current += detectMs
          if (detectMs < perfMinDetectMsRef.current) perfMinDetectMsRef.current = detectMs
          if (detectMs > perfMaxDetectMsRef.current) perfMaxDetectMsRef.current = detectMs
        }
      }
    } catch (err: any) {
      console.error('[mic] activation failed', err)
      const name = err?.name ? String(err.name) : 'UnknownError'
      const msg = err?.message ? String(err.message) : ''
      setError(`Cannot activate microphone: ${name}${msg ? ` - ${msg}` : ''}`)
    }
  }

  function stopMic() {
    lastEmittedPitchRef.current = null
    lastEmittedDistanceRoundedRef.current = null

    // Worklet cleanup
    try { pitchWorkletNodeRef.current?.disconnect() } catch {}
    try { pitchWorkletTapGainRef.current?.disconnect() } catch {}
    pitchWorkletNodeRef.current = null
    pitchWorkletTapGainRef.current = null
    useWorkletRef.current = false

    micStreamRef.current?.getTracks().forEach(t => t.stop())
    micStreamRef.current = null

    setMicActive(false)
    setPitchResult({ frequency: null, clarity: 0 })
    setDistanceCents(null)
    // Reset detector internals so next activation starts fresh
    resetPitchDetectorState()
  }

  /* =========================
     PLAYHEAD + CURSOR POSITION CACHE
  ========================= */
  async function buildPositionCache(): Promise<void> {
    positionsReadyRef.current = false
    if (!osmdRef.current || !scoreContainerRef.current || cursorStepsRef.current.length === 0) {
      cursorPositionsRef.current = []
      positionsReadyRef.current = true
      return
    }

    // Wait a frame to ensure OSMD has painted its cursor elements
    await new Promise(requestAnimationFrame)

    cursorPositionsRef.current = []
    osmdRef.current.cursor.reset()

    for (let i = 0; i < cursorStepsRef.current.length; i++) {
      const cursorElement = osmdRef.current.cursor.cursorElement
      if (cursorElement) {
        // Keep OSMD cursor invisible; we use our own playhead overlay for a smooth
        // visual marker. (Opacity preserves layout/geometry so measurements still work.)
        ;(cursorElement as any).style.opacity = '0'
        ;(cursorElement as any).style.pointerEvents = 'none'

        const cursorRect = cursorElement.getBoundingClientRect()
        const containerRect = scoreContainerRef.current.getBoundingClientRect()

        cursorPositionsRef.current.push({
          step: i,
          left: cursorRect.left - containerRect.left + scoreContainerRef.current.scrollLeft,
          top: cursorRect.top - containerRect.top + scoreContainerRef.current.scrollTop,
          height: cursorRect.height
        })
      }

      if (!osmdRef.current.cursor.Iterator.EndReached) {
        osmdRef.current.cursor.next()
      }
    }

    osmdRef.current.cursor.reset()
    osmdRef.current.cursor.update()
    positionsReadyRef.current = true
  }

  /* =========================
     PLAYHEAD ANIM LOOP
  ========================= */
  useEffect(() => {
    if (!playerRef.current || !osmdRef.current || !playheadRef.current || !scoreTimeline) return
    if (cursorStepsRef.current.length === 0) return

    let raf = 0
    let currentStepIndex = 0
    let scrollTargetTop: number | null = null

    const updateCursorPosition = () => {
      const player = playerRef.current
      const playhead = playheadRef.current
      const container = scoreContainerRef.current
      if (!player || !playhead || !container) return

      const t = player.getCurrentTime()
      const tempoBpm = scoreTimeline.tempoBpm

      let musicalTime = (t * tempoBpm) / 240
      const maxMusicalTime = cursorStepsRef.current[cursorStepsRef.current.length - 1]?.musicalTime || 0
      musicalTime = Math.max(0, Math.min(musicalTime, maxMusicalTime))

      // Incremental step tracking (avoid O(N) scan from 0 each frame)
      const steps = cursorStepsRef.current
      const lastIdx = steps.length - 1
      if (currentStepIndex > lastIdx) currentStepIndex = lastIdx
      if (currentStepIndex < 0) currentStepIndex = 0
      while (currentStepIndex < lastIdx && steps[currentStepIndex + 1].musicalTime <= musicalTime) currentStepIndex++
      while (currentStepIndex > 0 && steps[currentStepIndex].musicalTime > musicalTime) currentStepIndex--

      const currentStep = cursorStepsRef.current[currentStepIndex]
      const nextStep = cursorStepsRef.current[currentStepIndex + 1]

      if (currentStep && nextStep && cursorPositionsRef.current.length > currentStepIndex + 1) {
        const progress = (musicalTime - currentStep.musicalTime) / (nextStep.musicalTime - currentStep.musicalTime)

        const currentPos = cursorPositionsRef.current[currentStepIndex]
        const nextPos = cursorPositionsRef.current[currentStepIndex + 1]

        const left = currentPos.left + (nextPos.left - currentPos.left) * progress
        playhead.style.left = `${left}px`
        playhead.style.top = `${currentPos.top}px`
        playhead.style.height = `${currentPos.height}px`
      } else if (cursorPositionsRef.current.length > currentStepIndex) {
        const pos = cursorPositionsRef.current[currentStepIndex]
        playhead.style.left = `${pos.left}px`
        playhead.style.top = `${pos.top}px`
        playhead.style.height = `${pos.height}px`
      }

      // Smooth autoscroll: set a target and lerp toward it (avoids sudden jumps).
      if (cursorPositionsRef.current.length > currentStepIndex) {
        const pos = cursorPositionsRef.current[currentStepIndex]
        const scrollTop = container.scrollTop
        const viewH = container.clientHeight

        const bottomMargin = 200
        const topMargin = 100

        if (pos.top > scrollTop + viewH - bottomMargin) {
          scrollTargetTop = pos.top - viewH / 3
        } else if (pos.top < scrollTop + topMargin) {
          scrollTargetTop = pos.top - 150
        }

        if (scrollTargetTop != null) {
          const clampedTarget = Math.max(0, Math.min(scrollTargetTop, container.scrollHeight - viewH))
          const delta = clampedTarget - container.scrollTop
          // Lerp with a max step to keep it responsive but smooth.
          const step = Math.max(-40, Math.min(40, delta * 0.18))
          if (Math.abs(delta) < 1) {
            container.scrollTop = clampedTarget
            scrollTargetTop = null
          } else {
            container.scrollTop = container.scrollTop + step
          }
        }
      }
    }

    const tick = () => {
      const player = playerRef.current
      if (player?.isPlaying()) updateCursorPosition()
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [scoreTimeline])

  function resetPitchEvaluationState() {
    // Intentionally minimal for "raw pitchy" evaluation.
  }

  // Pitch detection is AudioWorklet-only.

  // Snapshot perf to UI periodically while mic is active
  useEffect(() => {
    let snapTimer: number | null = null
    if (micActive) {
      snapTimer = window.setInterval(() => {
        const iter = perfIterationsRef.current
        const avgLoop = iter ? perfTotalLoopMsRef.current / iter : 0
        const avgDetect = iter ? perfTotalDetectMsRef.current / iter : 0
        setPerfSnapshot({
          iter,
          avgLoop: Math.round(avgLoop),
          minLoop: Number.isFinite(perfMinLoopMsRef.current) ? Math.round(perfMinLoopMsRef.current) : 0,
          maxLoop: Math.round(perfMaxLoopMsRef.current),
          lastLoop: Math.round(perfLastLoopMsRef.current),
          avgDetect: Math.round(avgDetect),
          minDetect: Number.isFinite(perfMinDetectMsRef.current) ? Math.round(perfMinDetectMsRef.current) : 0,
          maxDetect: Math.round(perfMaxDetectMsRef.current),
          lastDetect: Math.round(perfLastDetectMsRef.current),
          skipped: perfSkippedRef.current
        })
        // occasional console log (every ~5s)
        const now = performance.now()
        if (now - perfLastConsoleMsRef.current > 5000) {
          perfLastConsoleMsRef.current = now
          console.log('[perf] iter=', perfIterationsRef.current, 'avgLoop=', Math.round(avgLoop), 'ms', 'lastLoop=', Math.round(perfLastLoopMsRef.current), 'avgDetect=', Math.round(avgDetect), 'ms', 'skipped=', perfSkippedRef.current)
        }
      }, 700)
    } else {
      setPerfSnapshot(null)
    }

    return () => {
      if (snapTimer) window.clearInterval(snapTimer)
    }
    // only tied to micActive
  }, [micActive])


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
        <div className="top-bar__row">
          <div className="top-bar__left">
            <button
              type="button"
              className="top-bar__iconBtn"
              aria-label="Back"
              title="Back"
              onClick={() => {
                try {
                  if (typeof window !== 'undefined' && window.history.length > 1) {
                    router.back()
                  } else {
                    router.push('/')
                  }
                } catch {
                  router.push('/')
                }
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <h1 className="top-bar__brand">
              <a href="/" aria-label="ChoirUp home">
                ChoirUp
              </a>
            </h1>
          </div>
          <button type="button" className="top-bar__infoBtn" aria-label="About" title="About" onClick={() => setAboutOpen(true)}>
            ?
          </button>
        </div>
      </header>

      <main className="main-content">
        <div className="score-section">
          <div className="file-upload-section">
            <label htmlFor="musicxml-file" className="file-upload-button">
              Open MusicXML/MXL-file
            </label>
            <input
              id="musicxml-file"
              type="file"
              accept=".xml,.musicxml,.mxl"
              onChange={handleFileSelect}
              className="file-input"
            />
            {isLoading && <p className="status-text">Loading...</p>}
            {error && <p className="error-text">{error}</p>}
          </div>

          <div ref={scoreContainerRef} id="score-container" className="score-container">
            <div ref={osmdContainerRef} className="osmd-container" />
            {!scoreTimeline && <p>Select a MusicXML or MXL file to display notes</p>}

            {scoreTimeline && (
              <>
                <canvas ref={trailCanvasRef} className="trail-canvas" />
                <div ref={playheadRef} className="playhead-marker" />

                <PerfOverlay perfSnapshot={perfSnapshot} micActive={micActive} />

                <PitchDetectorOverlay
                  micActive={micActive}
                  isPlaying={isPlaying}
                  currentTargetNote={currentTargetNote}
                  pitchResult={pitchResult}
                  distanceCents={distanceCents}
                  midiToNoteName={midiToNoteName}
                />
              </>
            )}
          </div>

          {scoreTimeline && (
            <TransportBar
              isPlaying={isPlaying}
              currentTime={currentTime}
              duration={scoreTimeline.totalDurationSeconds}
              onPlayPause={handlePlayPause}
              onStop={handleStop}
              onSeek={(t) => {
                // Keep behavior identical to the old slider handler.
                setCurrentTime(t)
                resetPitchEvaluationState()
                playerRef.current?.seekTo(t)
              }}
            />
          )}
        </div>

        <aside className="control-panel">
          <h3>Controls</h3>

          {scoreTimeline && (
            <>
              <div className="voice-selection">
                <h4>🎤 Select voice to practice</h4>
                <select value={selectedVoice || ''} onChange={e => setSelectedVoice(e.target.value as VoiceId)}>
                  {!selectedVoice && <option value="">Select voice...</option>}
                  {voicesHuman.map(v => (
                    <option key={v} value={v}>
                      {buildVoiceDisplayLabel(v, getVoices(), partMetadata)}
                    </option>
                  ))}
                </select>
              </div>
              <label>
                Difficulty:&nbsp;
                <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)}>
                  <option value="normal">Normal</option>
                  <option value="advanced">Advanced</option>
                  <option value="expert">Expert</option>
                </select>
              </label>

              <TunerPanel micActive={micActive} isPlaying={isPlaying} pitchResult={pitchResult} onMicToggle={handleMicToggle} />

              <LatencyControl
                micActive={micActive}
                latencyMs={latencyMs}
                setLatencyMs={setLatencyMs}
                calibrating={calibrating}
                calibrationMessage={calibrationMessage}
                onCalibrateSpeakers={async () => {
                  if (calibrating) return
                  setCalibrating(true)
                  setCalibrationMessage('Put mic on speaker. Sound latency is about to start')
                  try {
                    const ms = await calibrateLatency({ audioContext: audioContextRef.current, existingStream: micStreamRef.current, durationMs: 6000 })
                    setLatencyMs(Math.round(ms))
                    setCalibrationMessage(`Calibration complete: ${Math.round(ms)} ms`)
                  } catch (err: any) {
                    console.error(err)
                    setCalibrationMessage('Calibration failed: ' + (err?.message ?? 'Unknown error'))
                  } finally {
                    setCalibrating(false)
                    setTimeout(() => setCalibrationMessage(null), 3000)
                  }
                }}
                onCalibrateHeadphones={async () => {
                  if (calibrating) return
                  setCalibrating(true)
                  setCalibrationMessage("Headphones: listen to the metronome and say 'ta' every time you hear a tick")
                  try {
                    const ms = await calibrateLatencyHeadphones({ audioContext: audioContextRef.current, existingStream: micStreamRef.current, intervalMs: 800, clicks: 8 })
                    setLatencyMs(Math.round(ms))
                    setCalibrationMessage(`Calibration complete: ${Math.round(ms)} ms`)
                  } catch (err: any) {
                    console.error(err)
                    setCalibrationMessage('Calibration failed: ' + (err?.message ?? 'Unknown error'))
                  } finally {
                    setCalibrating(false)
                    setTimeout(() => setCalibrationMessage(null), 3000)
                  }
                }}
              />

              <div className="tempo-control" style={{ marginTop: 16 }}>
                <h4>🎵 Tempo</h4>
                <div className="tempo-display">
                  {Math.round(scoreTimeline.tempoBpm * tempoMultiplier)} BPM
                  <span className="tempo-original"> ({scoreTimeline.tempoBpm} BPM original)</span>
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

              <div className="voice-mixer" style={{ marginTop: 16 }}>
                <h4>Voices</h4>
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

      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  )
}
