/*
 * Copyright (c) 2025 Rickard Evertsson
 */

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

import { ScorePlayer, VoiceMixerSettings } from '../audio/ScorePlayer'
import { detectPitch, frequencyToNoteInfo, PitchResult, resetPitchDetectorState } from '../audio/pitchDetection'
import { calibrateLatency, calibrateLatencyHeadphones } from '../audio/latencyCalibration'

import './ScorePlayerPage.css'
import { PerfOverlay, PerfSnapshot } from './scorePlayerPage/PerfOverlay'
import { PitchDetectorOverlay } from './scorePlayerPage/PitchDetectorOverlay'
import { TunerPanel } from './scorePlayerPage/TunerPanel'
import { LatencyControl } from './scorePlayerPage/LatencyControl'
import { TransportBar } from './scorePlayerPage/TransportBar'
import { AboutModal } from './scorePlayerPage/AboutModal'

/* =========================
  CONSTANTS
========================= */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const FFT_SIZE              = 4096 // 4096 bytes => 93 ms
const ANALYSIS_INTERVAL_MS  = 50   // Periodic analysis
//const MIN_CLARITY           = 0.7  // Pitch gating
//const RED_THRESHOLD_CENTS   = 45;  // When to paint red
//const TRANSITION_WINDOW_SEC = 0.15 // Transition window (your setting)
//const TRANSITION_GRACE_MS   = 150; // Transition grace

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
     DEBUG
  ========================= */
  const DEBUG_PITCH = false

  const lastDbgRef = useRef({
    lastTargetsKey: '',
    lastLogMs: 0
  })

  function dbgLog(obj: any) {
    if (!DEBUG_PITCH) return
    const now = performance.now()
    // max 10 logs/sec so the console doesn't get overwhelmed
    if (now - lastDbgRef.current.lastLogMs < 100) return
    lastDbgRef.current.lastLogMs = now
    console.log(obj)
  }

  type Difficulty = 'easy' | 'medium' | 'hard';

  type PitchSettings = {
    MIN_CLARITY: number;
    RED_THRESHOLD_CENTS: number;
    TRANSITION_WINDOW_SEC: number;
    TRANSITION_GRACE_MS: number;
  };

  const DIFFICULTY_PRESETS: Record<Difficulty, PitchSettings> = {
    easy:   { MIN_CLARITY: 0.50, RED_THRESHOLD_CENTS: 85, TRANSITION_WINDOW_SEC: 0.15, TRANSITION_GRACE_MS: 150 },
    medium: { MIN_CLARITY: 0.70, RED_THRESHOLD_CENTS: 45, TRANSITION_WINDOW_SEC: 0.15, TRANSITION_GRACE_MS: 150 },
    hard:   { MIN_CLARITY: 0.75, RED_THRESHOLD_CENTS: 30, TRANSITION_WINDOW_SEC: 0.12, TRANSITION_GRACE_MS: 110 },
  };

  const pitchSettingsRef = useRef<PitchSettings>(DIFFICULTY_PRESETS.medium);


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
  const analyserRef = useRef<AnalyserNode | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const detectTimerRef = useRef<number | null>(null)
  const detectLoopRunningRef = useRef(false)
  const detectBufferRef = useRef<Float32Array | null>(null)
  const detectWindowHalfSecRef = useRef<{ fftSize: number; sampleRate: number; halfWindowSec: number } | null>(null)
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
     REFS: PITCH / STABILISERING
  ========================= */
  const stableMidiRef = useRef<number | null>(null)
  const lastHintMidiRef = useRef<number | null>(null)
  const lastStableJudgeMidiRef = useRef<number | null>(null);
  const lastStableCentsRef = useRef<number | null>(null);
  const transitionGraceUntilMsRef = useRef<number>(0);
  const lastTargetMidiForGraceRef = useRef<number | null>(null);
  const noteHadEvaluationRef = useRef(false)
  const lastNoteTargetRef = useRef<{ voice: VoiceId; midi: number; start: number; duration: number } | null>(null)

  // Trail throttling
  const TRAIL_MAX_HZ = 25
  const TRAIL_MIN_DX_PX = 1.5
  const lastTrailDrawMsRef = useRef<number>(0)
  const lastTrailXRef = useRef<number | null>(null)

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

  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
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

  const drawTrailAtPlayhead = (absCents: number) => {
    if (!positionsReadyRef.current) return
    const S = pitchSettingsRef.current;
    const ctx = trailCtxRef.current
    const canvas = trailCanvasRef.current
    const playhead = playheadRef.current
    const container = scoreContainerRef.current
    if (!ctx || !canvas || !playhead || !container) return

    if (absCents < S.RED_THRESHOLD_CENTS) return

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

    const effectiveCents = Math.max(0, absCents - S.RED_THRESHOLD_CENTS);
    const alpha = clamp(effectiveCents / 100, 0, 0.3)
    ctx.fillStyle = `rgba(239, 68, 68, ${alpha})`
    ctx.fillRect(left, top, 6, height)
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
      // Stop ongoing detect loop during file reinitialization; we'll restart it
      // below if the mic is still active and things are ready.
      stopDetectLoop()

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
        startDetectLoop()
      }
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
    stableMidiRef.current = null
    lastHintMidiRef.current = null

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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      })
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

      // Prefer AudioWorklet (Tier 4). Fallback to analyser polling when unsupported.
      useWorkletRef.current = false
      if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function') {
        try {
          await ctx.audioWorklet.addModule(
            new URL('../audio/worklets/pitchDetector.worklet.ts', import.meta.url)
          )

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
          analyserRef.current = null
          useWorkletRef.current = true
        } catch (e) {
          console.warn('[pitch] audioWorklet init failed; falling back to analyser loop', e)
          useWorkletRef.current = false
        }
      }

      if (!useWorkletRef.current) {
        const analyser = ctx.createAnalyser()
        analyser.fftSize = FFT_SIZE
        analyser.smoothingTimeConstant = 0.1
        source.connect(analyser)
        analyserRef.current = analyser
      }

      setMicActive(true)

      setPitchResult({ frequency: null, clarity: 0 })
      setDistanceCents(null)
      stableMidiRef.current = null
      lastHintMidiRef.current = null

      // reset pitch detection internal gate too
      resetPitchDetectorState()

      // Start detection:
      // - worklet mode is event-driven (port messages)
      // - analyser mode uses polling loop
      if (useWorkletRef.current && pitchWorkletNodeRef.current) {
        stopDetectLoop()
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

          const rawNow =
            analysisCenterAudioTimeSec != null && player
              ? player.getTimeAtAudioContextTime(analysisCenterAudioTimeSec)
              : (player?.getCurrentTime() ?? 0)

          const pitchTime = rawNow - (latencyMsRef.current || 0) / 1000

          // --- TARGET SELECTION (copied from detect loop, but driven by pitch messages) ---
          let t0: { midi: number; start: number; duration: number } | null = null
          let t1: { midi: number; start: number; duration: number } | null = null
          let targetsCount = 0

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
              const prev = notes[currentIdx - 1]
              const next = notes[currentIdx + 1]

              const includePrev = !!(prev && prev.midi !== cur.midi && pitchTime - S.TRANSITION_WINDOW_SEC <= cur.start)
              const includeNext = !!(next && next.midi !== cur.midi && pitchTime + S.TRANSITION_WINDOW_SEC >= cur.end)

              if (includePrev && includeNext) {
                t0 = { midi: cur.midi, start: cur.start, duration: cur.duration }
                t1 = { midi: next!.midi, start: next!.start, duration: next!.duration }
                targetsCount = 2
              } else if (includePrev) {
                t0 = { midi: prev!.midi, start: prev!.start, duration: prev!.duration }
                t1 = { midi: cur.midi, start: cur.start, duration: cur.duration }
                targetsCount = 2
              } else if (includeNext) {
                t0 = { midi: cur.midi, start: cur.start, duration: cur.duration }
                t1 = { midi: next!.midi, start: next!.start, duration: next!.duration }
                targetsCount = 2
              } else {
                t0 = { midi: cur.midi, start: cur.start, duration: cur.duration }
                t1 = null
                targetsCount = 1
              }

              if (targetsCount === 2 && t0!.midi === t1!.midi) {
                t0 = t1
                t1 = null
                targetsCount = 1
              }
            }

            if (targetsCount > 0) {
              const uiTarget = targetsCount === 2 ? t1! : t0!

              const prevMidi = lastTargetMidiForGraceRef.current
              if (prevMidi == null) {
                lastTargetMidiForGraceRef.current = uiTarget.midi
              } else if (prevMidi !== uiTarget.midi) {
                lastTargetMidiForGraceRef.current = uiTarget.midi

                const noteMs = (uiTarget.duration ?? 0) * 1000
                const dynamicGraceMs = Math.min(
                  S.TRANSITION_GRACE_MS,
                  Math.max(40, noteMs * 0.5)
                )
                transitionGraceUntilMsRef.current = performance.now() + dynamicGraceMs
              }

              // Feed hint back to worklet so it can narrow the search range.
              pitchWorkletNodeRef.current?.port.postMessage({ type: 'hint', targetMidi: uiTarget.midi })

              if (!currentTarget || currentTarget.midi !== uiTarget.midi) {
                const next = { voice, midi: uiTarget.midi, start: uiTarget.start, duration: uiTarget.duration }
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

          // --- PITCH RESULT + CENTS/JUDGEMENT (reuse existing page logic) ---
          const result = { frequency: data.frequency ?? null, clarity: data.clarity ?? 0 }

          // Reuse the same throttling used in the polling loop.
          const lastPitch = lastEmittedPitchRef.current
          const nextHz10 = result.frequency != null ? Math.round(result.frequency * 10) : null
          const lastHz10 = lastPitch?.frequency != null ? Math.round(lastPitch.frequency * 10) : null
          const nextClarityPct = Math.round((result.clarity ?? 0) * 100)
          const lastClarityPct = Math.round(((lastPitch?.clarity ?? 0)) * 100)
          if (nextHz10 !== lastHz10 || nextClarityPct !== lastClarityPct) {
            lastEmittedPitchRef.current = result
            setPitchResult(result)
          }

          const inTransitionGrace = performance.now() < transitionGraceUntilMsRef.current
          const isStableSignal = result.frequency != null && result.clarity >= S.MIN_CLARITY

          if (result.frequency && targetsCount > 0) {
            const noteInfo = frequencyToNoteInfo(result.frequency)
            if (noteInfo) {
              const rawMidi = noteInfo.exactMidi

              const hintMidi = targetsCount > 0 ? (targetsCount === 2 ? t1!.midi : t0!.midi) : undefined
              if (lastHintMidiRef.current == null || lastHintMidiRef.current !== hintMidi) {
                stableMidiRef.current = null
                lastHintMidiRef.current = hintMidi ?? null
                resetPitchDetectorState()
              }

              const prevStable = stableMidiRef.current
              const alpha = 0.35
              const stableMidi = prevStable == null ? rawMidi : prevStable * (1 - alpha) + rawMidi * alpha
              stableMidiRef.current = stableMidi

              const judgeMidi = rawMidi
              const TRANSITION_PAD_CENTS = 30
              const padMidi = TRANSITION_PAD_CENTS / 100

              let bestCents: number | null = null
              if (targetsCount === 1) {
                bestCents = (judgeMidi - t0!.midi) * 100
              } else {
                const m0 = t0!.midi
                const m1 = t1!.midi
                const lowMidi = Math.min(m0, m1)
                const highMidi = Math.max(m0, m1)
                const low = lowMidi - padMidi
                const high = highMidi + padMidi
                if (judgeMidi >= low && judgeMidi <= high) bestCents = 0
                else if (judgeMidi < low) bestCents = (judgeMidi - lowMidi) * 100
                else bestCents = (judgeMidi - highMidi) * 100
              }

              if (isStableSignal && bestCents != null) {
                lastStableJudgeMidiRef.current = judgeMidi
                lastStableCentsRef.current = bestCents
              }

              const effectiveCents =
                isStableSignal && bestCents != null ? bestCents : lastStableCentsRef.current

              const lastRounded = lastEmittedDistanceRoundedRef.current
              const nextRounded = effectiveCents == null ? null : Math.round(effectiveCents)
              if (nextRounded !== lastRounded) {
                lastEmittedDistanceRoundedRef.current = nextRounded
                setDistanceCents(effectiveCents)
              }

              if (player?.isPlaying() && isStableSignal && !inTransitionGrace && effectiveCents != null) {
                const abs = Math.abs(effectiveCents)
                if (abs >= S.RED_THRESHOLD_CENTS) drawTrailAtPlayhead(abs)
              }
            }
          } else {
            const lastRounded = lastEmittedDistanceRoundedRef.current
            const nextRounded = lastStableCentsRef.current == null ? null : Math.round(lastStableCentsRef.current)
            if (nextRounded !== lastRounded) {
              lastEmittedDistanceRoundedRef.current = nextRounded
              setDistanceCents(lastStableCentsRef.current)
            }
          }

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
      } else {
        startDetectLoop()
      }
    } catch (err) {
      console.error(err)
      setError('Cannot active microphone. Check permissions.')
    }
  }

  function stopMic() {
    // Stop any polling detect loop (fallback mode)
    if (detectTimerRef.current) window.clearTimeout(detectTimerRef.current)
    detectTimerRef.current = null
    detectLoopRunningRef.current = false
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
    analyserRef.current = null

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
    // pitch smoothing / hint
    stableMidiRef.current = null;
    lastHintMidiRef.current = null;

    // freeze state
    lastStableJudgeMidiRef.current = null;
    lastStableCentsRef.current = null;

    // transition + grace
    lastTargetMidiForGraceRef.current = null;
    transitionGraceUntilMsRef.current = 0;

    // note-level fallback
    noteHadEvaluationRef.current = false;
    lastNoteTargetRef.current = null;
  }

  /* =========================
     PITCH LOOP (freeze + transition grace)
  ========================= */
  function startDetectLoop() {
    if (detectLoopRunningRef.current) return
    detectLoopRunningRef.current = true

    const loop = () => {
      const S = pitchSettingsRef.current;
      const analyser = analyserRef.current
      const ctx = audioContextRef.current
      const timeline = timelineRef.current
      const player = playerRef.current

      if (!analyser || !ctx) {
        detectTimerRef.current = window.setTimeout(loop, ANALYSIS_INTERVAL_MS)
        return
      }

      const loopStartMs = performance.now()
      const nowMs = loopStartMs

      if (!detectBufferRef.current || detectBufferRef.current.length !== analyser.fftSize) {
        detectBufferRef.current = new Float32Array(analyser.fftSize)
      }
      const buffer = detectBufferRef.current
      // cast to any to avoid TypeScript DOM typing mismatch (ArrayBuffer vs SharedArrayBuffer)
      analyser.getFloatTimeDomainData(buffer as any)

      const sr = ctx.sampleRate
      const fftSize = analyser.fftSize
      const cached = detectWindowHalfSecRef.current
      let halfWindowSec: number
      if (cached && cached.fftSize === fftSize && cached.sampleRate === sr) {
        halfWindowSec = cached.halfWindowSec
      } else {
        halfWindowSec = (fftSize / sr) / 2
        detectWindowHalfSecRef.current = { fftSize, sampleRate: sr, halfWindowSec }
      }

      const rawNow = player?.getCurrentTime() ?? 0
      const correctedNow = rawNow - (latencyMsRef.current || 0) / 1000
      const pitchTime = correctedNow - halfWindowSec

      const voice = selectedVoiceRef.current
      const currentTarget = currentTargetNoteRef.current

      /* =========================
        TARGET SELECTION (optimized: two fixed slots)
      ========================= */
      let t0: { midi: number; start: number; duration: number } | null = null
      let t1: { midi: number; start: number; duration: number } | null = null
      let targetsCount = 0

      if (timeline && voice) {
        const notes = notesByVoiceRef.current?.[voice] ?? []

        // Use a per-voice index that we advance/retreat instead of scanning
        const idxMap = notesIndexByVoiceRef.current
        if (!(voice in idxMap)) idxMap[voice] = 0
        let currentIdx = idxMap[voice]

        // clamp to valid range
        if (currentIdx < 0) currentIdx = 0
        if (currentIdx >= notes.length) currentIdx = Math.max(0, notes.length - 1)

        // advance forward while pitchTime is beyond current note end
        while (currentIdx < notes.length && pitchTime >= notes[currentIdx].end) {
          currentIdx++
        }

        // step backward while pitchTime is before current note start
        while (currentIdx > 0 && pitchTime < notes[currentIdx].start) {
          currentIdx--
        }

        // if we fell off the end, set to last valid or -1 if none
        if (currentIdx >= notes.length) currentIdx = notes.length - 1

        // update stored index for this voice
        idxMap[voice] = currentIdx

        // if pitchTime is before the first note, mark not found
        if (notes.length === 0 || pitchTime < notes[0].start) currentIdx = -1

        if (currentIdx >= 0) {
          const cur = notes[currentIdx]
          const prev = notes[currentIdx - 1]
          const next = notes[currentIdx + 1]

          const includePrev = !!(prev && prev.midi !== cur.midi && pitchTime - S.TRANSITION_WINDOW_SEC <= cur.start)
          const includeNext = !!(next && next.midi !== cur.midi && pitchTime + S.TRANSITION_WINDOW_SEC >= cur.end)

          if (includePrev && includeNext) {
            // prev, cur, next -> keep last two (cur, next)
            t0 = { midi: cur.midi, start: cur.start, duration: cur.duration }
            t1 = { midi: next!.midi, start: next!.start, duration: next!.duration }
            targetsCount = 2
          } else if (includePrev) {
            // prev, cur -> keep both
            t0 = { midi: prev!.midi, start: prev!.start, duration: prev!.duration }
            t1 = { midi: cur.midi, start: cur.start, duration: cur.duration }
            targetsCount = 2
          } else if (includeNext) {
            // cur, next -> keep both
            t0 = { midi: cur.midi, start: cur.start, duration: cur.duration }
            t1 = { midi: next!.midi, start: next!.start, duration: next!.duration }
            targetsCount = 2
          } else {
            // only cur
            t0 = { midi: cur.midi, start: cur.start, duration: cur.duration }
            t1 = null
            targetsCount = 1
          }

          // If both targets are identical, keep only the latter
          if (targetsCount === 2 && t0!.midi === t1!.midi) {
            t0 = t1
            t1 = null
            targetsCount = 1
          }
        }

        /* =========================
          UI target + TRANSITION GRACE TRIGGER (A: target MIDI change)
        ========================= */
        if (targetsCount > 0) {
          const uiTarget = targetsCount === 2 ? t1! : t0!

          // Trigger grace only when target MIDI changes
          const prevMidi = lastTargetMidiForGraceRef.current
          if (prevMidi == null) {
            lastTargetMidiForGraceRef.current = uiTarget.midi
          } else if (prevMidi !== uiTarget.midi) {
            lastTargetMidiForGraceRef.current = uiTarget.midi

            const noteMs = (uiTarget.duration ?? 0) * 1000;

            // Grace = min(fast max, 50% of the note's length), but never below 40ms
            const dynamicGraceMs = Math.min(
              S.TRANSITION_GRACE_MS,
              Math.max(40, noteMs * 0.5)
            );

            transitionGraceUntilMsRef.current = nowMs + dynamicGraceMs
          }

          if (!currentTarget || currentTarget.midi !== uiTarget.midi) {
            const next = { voice, midi: uiTarget.midi, start: uiTarget.start, duration: uiTarget.duration }
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

      const inTransitionGrace = nowMs < transitionGraceUntilMsRef.current

      /* =========================
        TARGET CHANGE DETECT (low-allocation)
      ========================= */
      let aMidi: number | null = null
      let bMidi: number | null = null
      if (targetsCount === 1) {
        aMidi = t0!.midi
      } else if (targetsCount === 2) {
        const m0 = t0!.midi
        const m1 = t1!.midi
        aMidi = Math.min(m0, m1)
        bMidi = Math.max(m0, m1)
      }
      const targetsKey = targetsCount === 0 ? '' : (targetsCount === 1 ? String(aMidi) : `${aMidi},${bMidi}`)
      if (targetsKey !== lastDbgRef.current.lastTargetsKey) {
        lastDbgRef.current.lastTargetsKey = targetsKey

        // This reset is *behavioral* (not only debug): when targets change we
        // want to clear smoothing + detector gates so old note state doesn't
        // pollute new targets.
        stableMidiRef.current = null
        lastHintMidiRef.current = null
        resetPitchDetectorState()

        if (DEBUG_PITCH) {
          dbgLog({
            type: 'TARGETS_CHANGED',
            rawNow: rawNow.toFixed(3),
            correctedNow: correctedNow.toFixed(3),
            pitchTime: pitchTime.toFixed(3),
            targets: targetsCount === 0 ? [] : (targetsCount === 1 ? [aMidi!] : [aMidi!, bMidi!])
          })
        }
      }

      /* =========================
        PITCH DETECTION
      ========================= */
      const hintMidi = targetsCount > 0 ? (targetsCount === 2 ? t1!.midi : t0!.midi) : undefined
      // time detectPitch
      const detectStart = performance.now()
      const result = detectPitch(buffer, sr, hintMidi != null ? { targetMidi: hintMidi } : undefined)
      const detectEnd = performance.now()
      const detectMs = detectEnd - detectStart
      perfLastDetectMsRef.current = detectMs
      perfTotalDetectMsRef.current += detectMs
      if (detectMs > perfMaxDetectMsRef.current) perfMaxDetectMsRef.current = detectMs

      const isStableSignal = result.frequency != null && result.clarity >= S.MIN_CLARITY
      // Avoid rerenders when changes aren't user-visible.
      // - UI prints Hz with 1 decimal and clarity as integer percent
      // - so we only update state when those rounded values change
      const lastPitch = lastEmittedPitchRef.current
      const nextHz10 = result.frequency != null ? Math.round(result.frequency * 10) : null
      const lastHz10 = lastPitch?.frequency != null ? Math.round(lastPitch.frequency * 10) : null
      const nextClarityPct = Math.round((result.clarity ?? 0) * 100)
      const lastClarityPct = Math.round(((lastPitch?.clarity ?? 0)) * 100)
      if (nextHz10 !== lastHz10 || nextClarityPct !== lastClarityPct) {
        lastEmittedPitchRef.current = result
        setPitchResult(result)
      }

      /* =========================
        CENTS + FREEZE LOGIC
      ========================= */
      if (result.frequency && targetsCount > 0) {
        const noteInfo = frequencyToNoteInfo(result.frequency)
        if (noteInfo) {
          const rawMidi = noteInfo.exactMidi

          if (lastHintMidiRef.current == null || lastHintMidiRef.current !== hintMidi) {
            stableMidiRef.current = null
            lastHintMidiRef.current = hintMidi ?? null
            resetPitchDetectorState()
          }

          const prevStable = stableMidiRef.current
          const alpha = 0.35
          const stableMidi = prevStable == null ? rawMidi : prevStable * (1 - alpha) + rawMidi * alpha
          stableMidiRef.current = stableMidi

          const judgeMidi = rawMidi

          const TRANSITION_PAD_CENTS = 30
          const padMidi = TRANSITION_PAD_CENTS / 100

          let bestCents: number | null = null

          if (targetsCount === 1) {
            const m = t0!.midi
            // cents = 100 * (midiDiff)
            bestCents = (judgeMidi - m) * 100
          } else {
            const m0 = t0!.midi
            const m1 = t1!.midi
            const lowMidi = Math.min(m0, m1)
            const highMidi = Math.max(m0, m1)

            const low = lowMidi - padMidi
            const high = highMidi + padMidi

            if (judgeMidi >= low && judgeMidi <= high) bestCents = 0
            else if (judgeMidi < low) bestCents = (judgeMidi - lowMidi) * 100
            else bestCents = (judgeMidi - highMidi) * 100
          }

          // Freeze: update last stable only when signal is stable AND we have a cents value
          if (isStableSignal && bestCents != null) {
            lastStableJudgeMidiRef.current = judgeMidi
            lastStableCentsRef.current = bestCents
          }

          const effectiveCents =
            isStableSignal && bestCents != null ? bestCents : lastStableCentsRef.current

          // Avoid rerenders when the displayed value (rounded cents) is unchanged.
          const lastRounded = lastEmittedDistanceRoundedRef.current
          const nextRounded = effectiveCents == null ? null : Math.round(effectiveCents)
          if (nextRounded !== lastRounded) {
            lastEmittedDistanceRoundedRef.current = nextRounded
            setDistanceCents(effectiveCents)
          }

          // Trail: only when stable AND not in transition grace
          if (player?.isPlaying() && isStableSignal && !inTransitionGrace && effectiveCents != null) {
            const abs = Math.abs(effectiveCents)
            if (abs >= S.RED_THRESHOLD_CENTS) {
              drawTrailAtPlayhead(abs)
            }
          }
        } else {
          const lastRounded = lastEmittedDistanceRoundedRef.current
          const nextRounded = lastStableCentsRef.current == null ? null : Math.round(lastStableCentsRef.current)
          if (nextRounded !== lastRounded) {
            lastEmittedDistanceRoundedRef.current = nextRounded
            setDistanceCents(lastStableCentsRef.current)
          }
        }
      } else {
        const lastRounded = lastEmittedDistanceRoundedRef.current
        const nextRounded = lastStableCentsRef.current == null ? null : Math.round(lastStableCentsRef.current)
        if (nextRounded !== lastRounded) {
          lastEmittedDistanceRoundedRef.current = nextRounded
          setDistanceCents(lastStableCentsRef.current)
        }
      }

      const loopEndMs = performance.now()
      const loopMs = loopEndMs - loopStartMs
      perfLastLoopMsRef.current = loopMs
      perfTotalLoopMsRef.current += loopMs
      perfIterationsRef.current += 1
      if (loopMs > perfMaxLoopMsRef.current) perfMaxLoopMsRef.current = loopMs
      if (loopMs > ANALYSIS_INTERVAL_MS) perfSkippedRef.current += 1

      detectTimerRef.current = window.setTimeout(loop, ANALYSIS_INTERVAL_MS)
    }

    loop()
  }

  function stopDetectLoop() {
    if (detectTimerRef.current) {
      window.clearTimeout(detectTimerRef.current)
      detectTimerRef.current = null
    }
    detectLoopRunningRef.current = false

    // Reset UI-throttling caches so next start emits immediately.
    lastEmittedPitchRef.current = null
    lastEmittedDistanceRoundedRef.current = null

    // reset perf snapshot and counters
    perfIterationsRef.current = 0
    perfTotalLoopMsRef.current = 0
    perfMinLoopMsRef.current = Infinity
    perfMaxLoopMsRef.current = 0
    perfLastLoopMsRef.current = 0
    perfTotalDetectMsRef.current = 0
    perfMinDetectMsRef.current = Infinity
    perfMaxDetectMsRef.current = 0
    perfLastDetectMsRef.current = 0
    perfSkippedRef.current = 0
    setPerfSnapshot(null)
  }

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
          <h1>Choir Practice Tool</h1>
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
                startDetectLoop()
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
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
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
