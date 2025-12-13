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
    canvas.width = container.scrollWidth || container.clientWidth || 1
    canvas.height = container.scrollHeight || container.clientHeight || 1
    trailCtxRef.current = canvas.getContext('2d')
  }, [scoreTimeline])

  function clearTrail() {
    const ctx = trailCtxRef.current
    const canvas = trailCanvasRef.current
    if (!ctx || !canvas) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  function drawTrailMark(absCents: number) {
    const ctx = trailCtxRef.current
    const canvas = trailCanvasRef.current
    if (!ctx || !canvas) return

    // superenkel visual: liten vertikal mark till vänster (för att se att gating funkar)
    // (vi lägger tillbaka “rita vid playhead” senare)
    const x = 10
    const y = 10
    const w = 6
    const h = 20

    let color = 'rgba(239,68,68,0.45)'
    if (absCents < 10) color = 'rgba(34,197,94,0.35)'
    if (absCents >= 50) color = 'rgba(239,68,68,0.65)'
    ctx.fillStyle = color
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

      const metadata = extractPartMetadata(xmlContent)
      setPartMetadata(metadata)

      const timeline = await buildScoreTimelineFromMusicXml(xmlContent)
      timelineRef.current = timeline
      setScoreTimeline(timeline)
      setCurrentTime(0)

      clearTrail()

      // auto-select första human voice
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

      // init voice settings
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
    else p.play()
  }

  function handleStop() {
    const p = playerRef.current
    if (!p) return
    p.stop()
    setCurrentTime(0)
    setIsPlaying(false)

    // reset pitch-related
    setCurrentTargetNote(null)
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

      // window timing
      const sr = ctx.sampleRate
      const windowSec = analyser.fftSize / sr
      const halfWindowSec = windowSec / 2

      // pitchTime: align mic-window center with playback time minus latency
      const rawNow = player?.getCurrentTime() ?? 0
      const correctedNow = rawNow - (latencyMsRef.current || 0) / 1000
      const pitchTime = correctedNow - halfWindowSec

      // pick target (selected voice + pitchTime)
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

          // target note change?
          if (!currentTargetNote || currentTargetNote.midi !== targetMidi) {
            setCurrentTargetNote({
              voice,
              midi: targetMidi,
              start: targetStart,
              duration: targetDuration
            })
            targetStartRef.current = targetStart

            stableMidiRef.current = null

            if (lastTargetMidiRef.current != null && lastTargetMidiRef.current !== targetMidi) {
              attackUntilRef.current = pitchTime + ATTACK_PHASE_MS / 1000
            } else {
              attackUntilRef.current = pitchTime + ATTACK_PHASE_MS / 1000
            }
            lastTargetMidiRef.current = targetMidi
          }
        } else {
          setCurrentTargetNote(null)
          targetStartRef.current = null
          lastTargetMidiRef.current = null
          stableMidiRef.current = null
          setDistanceCents(null)
        }
      }

      const result = detectPitch(buffer, sr, targetMidi != null ? { targetMidi } : undefined)
      setPitchResult(result)

      // compute cents (stable midi)
      if (result.frequency && targetMidi != null) {
        const noteInfo = frequencyToNoteInfo(result.frequency)
        if (noteInfo) {
          const rawMidi = noteInfo.exactMidi
          const prev = stableMidiRef.current
          const stable = prev == null ? rawMidi : prev * 0.75 + rawMidi * 0.25
          stableMidiRef.current = stable

          const cents =
            1200 * Math.log2(midiToFrequency(stable) / midiToFrequency(targetMidi))
          setDistanceCents(cents)

          // trail gating: ingen “röd dom” under attack eller låg clarity
          const inAttack = pitchTime < attackUntilRef.current
          if (!inAttack && result.clarity >= MIN_CLARITY) {
            const abs = Math.abs(cents)
            if (abs >= 10) drawTrailMark(abs)
          }
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
                {/* overlay tuner */}
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
                          {distanceCents != null ? `${distanceCents > 0 ? '+' : ''}${Math.round(distanceCents)} cent` : '--- cent'}
                        </span>
                        <span className="pitch-clarity">Clarity: {Math.round((pitchResult.clarity ?? 0) * 100)}%</span>
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
                        <div className="pitch-note">
                          Not: {frequencyToNoteInfo(pitchResult.frequency)?.noteName ?? '---'}
                        </div>
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
