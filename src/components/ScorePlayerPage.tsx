import { useRef, useEffect, useState } from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import JSZip from 'jszip'
import { ScoreTimeline, VoiceId } from '../types/ScoreTimeline'
import { buildScoreTimelineFromMusicXml, extractPartMetadata, buildVoiceDisplayLabel, PartMetadata } from '../utils/musicXmlParser'
import { ScorePlayer, VoiceMixerSettings, midiToFrequency } from '../audio/ScorePlayer'
import { detectPitch, frequencyToNoteInfo, PitchResult, TargetHint } from '../audio/pitchDetection'
import './ScorePlayerPage.css'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Two-phase pitch evaluation: ATTACK (pitch lock) vs SUSTAIN (quality evaluation)
const ATTACK_PHASE_MS = 80;  // Attack phase: pitch lock only, no quality evaluation

// Grace window and stability constants (dynamic per note duration)
const MAX_GRACE_MS = 120;
const MIN_GRACE_MS = 35;
const MAX_STABLE_MS = 120;
const MIN_STABLE_MS = 35;

function midiToNoteName(midi: number): string {
  const noteIndex = midi % 12;
  const octave = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[noteIndex] + octave;
}

function makeTargetKey(note: { voice: string; startTimeSeconds: number; midiPitch: number }): string {
  return `${note.voice}|${note.startTimeSeconds.toFixed(3)}|${note.midiPitch}`;
}

function ScorePlayerPage() {
  const scoreContainerRef = useRef<HTMLDivElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null)
  const [error, setError] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const [scoreTimeline, setScoreTimeline] = useState<ScoreTimeline | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [voiceSettings, setVoiceSettings] = useState<Record<VoiceId, VoiceMixerSettings>>({})
  const [partMetadata, setPartMetadata] = useState<PartMetadata[]>([])
  const cursorStepsRef = useRef<Array<{ step: number; musicalTime: number }>>([])
  const playerRef = useRef<ScorePlayer | null>(null)
  
  // Pitch detection state
  const [micActive, setMicActive] = useState(false)
  const [pitchResult, setPitchResult] = useState<PitchResult>({ frequency: null, clarity: 0 })
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const animationFrameRef = useRef<number>(0)
  
  // MIDI stabilization state
  const stableMidiRef = useRef<number | null>(null)
  const lastMidiRef = useRef<number | null>(null)
  const jumpFramesRef = useRef<number>(0)
  const lastTargetMidiRef = useRef<number | null>(null)
  
  // Note change grace window and pitch stability tracking
  const currentTargetKeyRef = useRef<string | null>(null)
  const targetStartTimeRef = useRef<number | null>(null)
  const targetDurationSecondsRef = useRef<number | null>(null)
  const stableSinceRef = useRef<number | null>(null)
  const lastPitchMidiRef = useRef<number | null>(null)
  
  // Voice matching state
  interface VoiceMatch {
    voiceId: VoiceId;
    displayLabel: string;
    targetMidi: number;
    distanceCents: number;
  }
  const [voiceMatch, setVoiceMatch] = useState<VoiceMatch | null>(null)
  
  // Current target note (visas alltid när det finns aktiva noter)
  const [currentTargetNote, setCurrentTargetNote] = useState<{ displayLabel: string; targetMidi: number } | null>(null)
  
  // Selected voice for pitch detection (no auto mode)
  const [selectedVoice, setSelectedVoice] = useState<VoiceId | null>(null)
  const selectedVoiceRef = useRef<VoiceId | null>(null)
  
  // Voice selection menu state
  const [showVoiceMenu, setShowVoiceMenu] = useState(false)
  
  // Corner controls state
  const [showSpeedSlider, setShowSpeedSlider] = useState(false)
  const [showMixerPanel, setShowMixerPanel] = useState(false)
  
  // Synkronisera selectedVoiceRef med selectedVoice state och rensa state
  useEffect(() => {
    selectedVoiceRef.current = selectedVoice;
    
    // Rensa state när stämma byts (endast om mikrofon är aktiv)
    if (micActive) {
      setPitchResult({ frequency: null, clarity: 0 });
      setVoiceMatch(null);
      setDebugMatchInfo(null);
      setDebugActiveNotesByVoice(new Map());
      clearTrail();
    }
  }, [selectedVoice, micActive])
  
  // Auto-select first human voice when timeline loads
  useEffect(() => {
    if (scoreTimeline && !selectedVoice) {
      const humanVoices = getVoices().filter(v => !v.toLowerCase().includes('keyboard'));
      if (humanVoices.length > 0) {
        setSelectedVoice(humanVoices[0]);
      }
    }
  }, [scoreTimeline, selectedVoice])
  
  // Tempo control
  const [tempoMultiplier, setTempoMultiplier] = useState(1.0)
  
  // Latency compensation
  const [latencyMs, setLatencyMs] = useState<number>(220)
  const latencyMsRef = useRef<number>(latencyMs)
  useEffect(() => { latencyMsRef.current = latencyMs; }, [latencyMs])
  
  // Debug state
  const [debugActiveNotes, setDebugActiveNotes] = useState(0)
  const [debugActiveNotesByVoice, setDebugActiveNotesByVoice] = useState<Map<VoiceId, Array<{ noteName: string; midi: number }>>>(new Map())
  const [debugMatchInfo, setDebugMatchInfo] = useState<{
    bestVoice: VoiceId | null;
    bestTargetMidi: number;
    bestDistanceCents: number;
    allDistances: Array<{ voice: VoiceId; targetMidi: number; distanceCents: number }>;
  } | null>(null)
  const [debugTimeInfo, setDebugTimeInfo] = useState<{
    playbackTimeSeconds: number;
    cursorWholeTime: number;
    cursorMeasureIndex: number;
  } | null>(null)
  const [debugNoteIntervals, setDebugNoteIntervals] = useState<Array<{
    voice: VoiceId;
    displayLabel: string;
    pitch: string;
    startWhole: number;
    endWhole: number;
    isActive: boolean;
  }>>([])
  const [debugPhaseInfo, setDebugPhaseInfo] = useState<{
    phase: 'ATTACK' | 'SUSTAIN' | 'NONE';
    timeSinceNoteStartMs: number;
    distanceCents: number;
    clarity: number;
  } | null>(null)
  
  // Färgspår för pitch accuracy (canvas)
  const trailCanvasRef = useRef<HTMLCanvasElement>(null);
  const trailCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const lastTrailPositionRef = useRef<number>(-1);
  const trailFrameCountRef = useRef<number>(0);

  // Initiera OSMD när komponenten mountas
  useEffect(() => {
    if (scoreContainerRef.current && !osmdRef.current) {
      try {
        osmdRef.current = new OpenSheetMusicDisplay(scoreContainerRef.current, {
          autoResize: true,
          backend: 'svg',
          followCursor: false,
          drawingParameters: 'compact'
        })
        console.log('OSMD initialiserat')
      } catch (err) {
        console.error('Fel vid initiering av OSMD:', err)
        setError('Kunde inte initiera notvisaren')
      }
    }
  }, [])

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setError('')
    setIsLoading(true)

    try {
      const xmlContent = await readFile(file)
      
      // Ladda OSMD
      if (osmdRef.current) {
        await osmdRef.current.load(xmlContent)
        await osmdRef.current.render()
        
        // Initiera cursor och bygg musical-time mapping
        osmdRef.current.cursor.show()
        osmdRef.current.cursor.reset()
        
        const steps: Array<{ step: number; musicalTime: number }> = []
        let i = 0
        
        while (!osmdRef.current.cursor.Iterator.EndReached) {
          const timestamp = osmdRef.current.cursor.Iterator.CurrentSourceTimestamp
          steps.push({
            step: i,
            musicalTime: timestamp ? timestamp.RealValue : 0
          })
          
          osmdRef.current.cursor.next()
          i++
        }
        
        cursorStepsRef.current = steps
        console.log(`Byggde cursor mapping: ${steps.length} steg, max musical time: ${steps[steps.length - 1]?.musicalTime || 0} beats`)
        
        // Reset till början
        osmdRef.current.cursor.reset()
      }
      
      // Extrahera part-metadata
      const metadata = extractPartMetadata(xmlContent)
      setPartMetadata(metadata)
      
      // Bygg ScoreTimeline
      const timeline = await buildScoreTimelineFromMusicXml(xmlContent)
      
      setScoreTimeline(timeline)
      setCurrentTime(0)
      
      // Rensa färgspår vid ny fil
      clearTrail();
      
      // Bygg position-cache EN GÅNG vid fil-laddning
      setTimeout(() => {
        buildPositionCache();
      }, 100);
      
    } catch (err) {
      console.error('Fel vid laddning av fil:', err)
      const errorMessage = err instanceof Error ? err.message : 'Okänt fel'
      setError(`Kunde inte ladda filen: ${errorMessage}`)
    } finally {
      setIsLoading(false)
    }
  }

  const readFile = async (file: File): Promise<string> => {
    if (file.name.toLowerCase().endsWith('.mxl')) {
      // Hantera MXL-filer (komprimerade)
      const arrayBuffer = await file.arrayBuffer()
      const zip = await JSZip.loadAsync(arrayBuffer)
      
      // Hitta huvudfilen från container.xml
      let xmlFile = null
      const containerFile = zip.file('META-INF/container.xml')
      
      if (containerFile) {
        const containerXml = await containerFile.async('text')
        const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml')
        const rootfile = containerDoc.querySelector('rootfile')
        const fullPath = rootfile?.getAttribute('full-path')
        
        if (fullPath) {
          xmlFile = zip.file(fullPath)
        }
      }
      
      // Fallback: leta efter score.xml eller första XML-fil
      if (!xmlFile) {
        xmlFile = zip.file('score.xml') || 
                  Object.values(zip.files).find(f => 
                    (f.name.endsWith('.xml') || f.name.endsWith('.musicxml')) && 
                    !f.dir && 
                    !f.name.includes('META-INF')
                  )
      }
      
      if (!xmlFile) {
        throw new Error('Ingen XML-fil hittades i MXL-arkivet')
      }
      
      const xmlContent = await xmlFile.async('text')
      
      // Kontrollera XML-format
      const parser = new DOMParser()
      const xmlDoc = parser.parseFromString(xmlContent, 'application/xml')
      const rootElement = xmlDoc.documentElement.nodeName
      
      console.log('XML root element:', rootElement)
      
      if (rootElement === 'score-timewise') {
        throw new Error('Timewise MusicXML stöds inte ännu')
      }
      
      return xmlContent
    } else {
      // Hantera vanliga XML-filer
      const xmlContent = await file.text()
      
      // Kontrollera XML-format
      const parser = new DOMParser()
      const xmlDoc = parser.parseFromString(xmlContent, 'application/xml')
      const rootElement = xmlDoc.documentElement.nodeName
      
      console.log('XML root element:', rootElement)
      
      if (rootElement === 'score-timewise') {
        throw new Error('Timewise MusicXML stöds inte ännu')
      }
      
      return xmlContent
    }
  }

  // Skapa ScorePlayer när timeline ändras
  useEffect(() => {
    if (scoreTimeline) {
      if (playerRef.current) {
        playerRef.current.dispose()
      }
      try {
        playerRef.current = new ScorePlayer(scoreTimeline, { partMetadata })
        
        // Initiera voice settings state
        const initialSettings: Record<VoiceId, VoiceMixerSettings> = {}
        const voices = Array.from(new Set(scoreTimeline.notes.map(n => n.voice)))
        voices.forEach(voice => {
          initialSettings[voice] = playerRef.current!.getVoiceSettings(voice)
        })
        setVoiceSettings(initialSettings)
        
        console.log('ScorePlayer skapad')
      } catch (err) {
        console.error('Fel vid skapande av ScorePlayer:', err)
        setError('Kunde inte skapa ljudspelare')
      }
    }
    return () => {
      if (playerRef.current) {
        playerRef.current.dispose()
        playerRef.current = null
      }
    }
  }, [scoreTimeline, partMetadata])

  // Uppdatera currentTime när spelaren spelar
  useEffect(() => {
    if (!playerRef.current || !scoreTimeline) return

    const updateTime = () => {
      if (playerRef.current && scoreTimeline) {
        const currentTime = playerRef.current.getCurrentTime()
        const duration = scoreTimeline.totalDurationSeconds
        
        setCurrentTime(currentTime)
        setIsPlaying(playerRef.current.isPlaying())
        
        // Auto-loop: Om vi nått slutet och spelar, starta om
        if (playerRef.current.isPlaying() && currentTime >= duration - 0.1) {
          playerRef.current.seekTo(0)
          if (osmdRef.current) {
            osmdRef.current.cursor.reset()
            osmdRef.current.cursor.update()
          }
          clearTrail()
          // Rensa pitch detection state för ny loop
          setPitchResult({ frequency: null, clarity: 0 })
          setVoiceMatch(null)
          setCurrentTargetNote(null)
          setDebugMatchInfo(null)
          setDebugActiveNotesByVoice(new Map())
        }
      }
    }

    const interval = setInterval(updateTime, 100)
    return () => clearInterval(interval)
  }, [scoreTimeline])

  // Cache för cursor-positioner
  const cursorPositionsRef = useRef<Array<{ step: number; left: number; top: number; height: number }>>([]);
  
  // Bygg position-cache (anropas EN GÅNG vid fil-laddning)
  const buildPositionCache = () => {
    if (!osmdRef.current || !scoreContainerRef.current || cursorStepsRef.current.length === 0) return;
    
    cursorPositionsRef.current = [];
    osmdRef.current.cursor.reset();
    
    for (let i = 0; i < cursorStepsRef.current.length; i++) {
      const cursorElement = osmdRef.current.cursor.cursorElement;
      if (cursorElement) {
        const cursorRect = cursorElement.getBoundingClientRect();
        const containerRect = scoreContainerRef.current.getBoundingClientRect();
        
        cursorPositionsRef.current.push({
          step: i,
          left: cursorRect.left - containerRect.left + scoreContainerRef.current.scrollLeft,
          top: cursorRect.top - containerRect.top + scoreContainerRef.current.scrollTop,
          height: cursorRect.height
        });
      }
      
      if (!osmdRef.current.cursor.Iterator.EndReached) {
        osmdRef.current.cursor.next();
      }
    }
    
    // Återställ cursor till början
    osmdRef.current.cursor.reset();
    osmdRef.current.cursor.update();
    
    console.log(`Position-cache byggd: ${cursorPositionsRef.current.length} positioner`);
  };

  // Playhead animation loop med OSMD Cursor (musical-time baserad + interpolation)
  useEffect(() => {
    if (!playerRef.current || !osmdRef.current || !playheadRef.current || !scoreTimeline) return
    if (cursorStepsRef.current.length === 0) return

    let raf = 0
    let lastStep = -1

    function updateCursorPosition() {
      if (!playerRef.current || !osmdRef.current || !playheadRef.current || !scoreContainerRef.current) return

      const t = playerRef.current.getCurrentTime()
      const tempoBpm = scoreTimeline.tempoBpm
      
      // Konvertera wall-clock time → musical time (whole note fractions)
      // BPM = beats per minute, 1 beat = 1/4 whole note
      let musicalTime = (t * tempoBpm) / 240
      
      // Clampa musical time
      const maxMusicalTime = cursorStepsRef.current[cursorStepsRef.current.length - 1]?.musicalTime || 0
      musicalTime = Math.max(0, Math.min(musicalTime, maxMusicalTime))

      // Hitta nuvarande och nästa cursor step
      let currentStepIndex = 0
      for (let i = 0; i < cursorStepsRef.current.length; i++) {
        if (cursorStepsRef.current[i].musicalTime <= musicalTime) {
          currentStepIndex = i
        } else {
          break
        }
      }
      
      const targetStep = cursorStepsRef.current[currentStepIndex].step

      // Flytta cursor endast om steget ändrats (för visuell feedback)
      if (targetStep !== lastStep) {
        osmdRef.current.cursor.reset()
        
        // Flytta cursor till rätt position
        for (let i = 0; i < targetStep; i++) {
          if (osmdRef.current.cursor.Iterator.EndReached) break
          osmdRef.current.cursor.next()
        }
        
        osmdRef.current.cursor.update()
        lastStep = targetStep
      }

      // Interpolera markörens position
      const currentStep = cursorStepsRef.current[currentStepIndex];
      const nextStep = cursorStepsRef.current[currentStepIndex + 1];
      
      if (currentStep && nextStep && cursorPositionsRef.current.length > currentStepIndex + 1) {
        // Beräkna progress mellan steps (0.0 - 1.0)
        const progress = (musicalTime - currentStep.musicalTime) / 
                        (nextStep.musicalTime - currentStep.musicalTime);
        
        const currentPos = cursorPositionsRef.current[currentStepIndex];
        const nextPos = cursorPositionsRef.current[currentStepIndex + 1];
        
        // Interpolera X-position
        const interpolatedLeft = currentPos.left + (nextPos.left - currentPos.left) * progress;
        
        playheadRef.current.style.left = `${interpolatedLeft}px`;
        playheadRef.current.style.top = `${currentPos.top}px`;
        playheadRef.current.style.height = `${currentPos.height}px`;
      } else if (cursorPositionsRef.current.length > currentStepIndex) {
        // Fallback: använd exakt position
        const pos = cursorPositionsRef.current[currentStepIndex];
        playheadRef.current.style.left = `${pos.left}px`;
        playheadRef.current.style.top = `${pos.top}px`;
        playheadRef.current.style.height = `${pos.height}px`;
      }

      // Custom auto-scroll (OSMD's followCursor disabled to avoid conflicts)
      if (cursorPositionsRef.current.length > currentStepIndex) {
        const pos = cursorPositionsRef.current[currentStepIndex];
        const container = scoreContainerRef.current;
        const containerScrollTop = container.scrollTop;
        const containerHeight = container.clientHeight;
        
        // Scrolla endast om markören är utanför synligt område
        if (pos.top > containerScrollTop + containerHeight - 100) {
          // Markören nära botten - scrolla ner
          container.scrollTop = pos.top - containerHeight / 2;
        } else if (pos.top < containerScrollTop + 50) {
          // Markören nära toppen - scrolla upp
          container.scrollTop = pos.top - 100;
        }
      }
    }

    function update() {
      if (!playerRef.current || !osmdRef.current) {
        raf = requestAnimationFrame(update)
        return
      }

      if (playerRef.current.isPlaying()) {
        updateCursorPosition()
      }

      raf = requestAnimationFrame(update)
    }

    raf = requestAnimationFrame(update)

    return () => cancelAnimationFrame(raf)
  }, [scoreTimeline])

  const handlePlay = () => {
    if (!playerRef.current || !osmdRef.current) return
    
    if (isPlaying) {
      playerRef.current.pause()
    } else {
      // Reset cursor vid start från början
      if (playerRef.current.getCurrentTime() === 0) {
        osmdRef.current.cursor.reset()
        osmdRef.current.cursor.update()
        // Rensa allt när vi startar från början
        clearTrail();
      } else {
        // Rensa färgspår till höger om markören när vi fortsätter
        clearTrailAhead();
      }
      
      playerRef.current.play()
    }
  }

  const handleStop = () => {
    if (!playerRef.current || !osmdRef.current) return
    playerRef.current.stop()
    osmdRef.current.cursor.reset()
    osmdRef.current.cursor.update()
    
    // Reset pitch detection state
    setPitchResult({ frequency: null, clarity: 0 })
    setVoiceMatch(null)
  }

  const handleSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(event.target.value)
    setCurrentTime(time)
    if (playerRef.current && osmdRef.current) {
      playerRef.current.seekTo(time)
      // Cursor uppdateras i animation loop
    }
  }
  
  const handleTempoChange = (newMultiplier: number) => {
    if (playerRef.current) {
      playerRef.current.setTempoMultiplier(newMultiplier)
      setTempoMultiplier(newMultiplier)
    }
  }

  const getVoices = (): VoiceId[] => {
    if (!scoreTimeline) return []
    return Array.from(new Set(scoreTimeline.notes.map(n => n.voice)))
  }

  const getVoiceSettings = (voice: VoiceId): VoiceMixerSettings => {
    return voiceSettings[voice] || {
      volume: 1.0,
      muted: false,
      solo: false
    }
  }

  const handleVoiceSettingsChange = (voice: VoiceId, settings: Partial<VoiceMixerSettings>) => {
    // Uppdatera React state för omedelbar UI-uppdatering
    setVoiceSettings(prev => ({
      ...prev,
      [voice]: { ...prev[voice], ...settings }
    }))
    
    // Uppdatera också spelaren
    if (playerRef.current) {
      playerRef.current.setVoiceSettings(voice, settings)
    }
  }
  
  // Helper: Get beat durations based on current tempo
  function getBeatDurations(): { quarter: number; sixteenth: number } {
    if (!scoreTimeline) {
      const quarter = 60 / 120;
      return { quarter, sixteenth: quarter / 4 };
    }
    const effectiveTempo = scoreTimeline.tempoBpm * tempoMultiplier;
    const quarter = 60 / effectiveTempo;
    return { quarter, sixteenth: quarter / 4 };
  }
  
  // MIDI stabilization function
  function stabilizeMidi(rawMidi: number): number {
    const stableMidi = stableMidiRef.current;
    const lastMidi = lastMidiRef.current;
    let jumpFrames = jumpFramesRef.current;

    if (stableMidi == null) {
      stableMidiRef.current = rawMidi;
      lastMidiRef.current = rawMidi;
      jumpFramesRef.current = 0;
      return rawMidi;
    }

    // 100 cent per halvton
    const diffCents = 100 * (rawMidi - stableMidi);
    const absDiff = Math.abs(diffCents);

    // Små variationer (< 20 cent) → mjuk smoothing
    if (absDiff < 20) {
      const smoothed = stableMidi * 0.7 + rawMidi * 0.3;
      stableMidiRef.current = smoothed;
      lastMidiRef.current = rawMidi;
      jumpFramesRef.current = 0;
      return smoothed;
    }

    // Mellanstora hopp (20–80 cent) → mer följsamt
    if (absDiff < 80) {
      const smoothed = stableMidi * 0.4 + rawMidi * 0.6;
      stableMidiRef.current = smoothed;
      lastMidiRef.current = rawMidi;
      jumpFramesRef.current = 0;
      return smoothed;
    }

    // Stora hopp (>= 80 cent) → potentiellt nytt tonsteg (halvton eller mer)
    const sameDirection =
      lastMidi != null && Math.sign(rawMidi - stableMidi) === Math.sign(lastMidi - stableMidi);

    jumpFrames = sameDirection ? jumpFrames + 1 : 1;

    // Kräver 5 konsekutiva frames i samma riktning innan vi accepterar ny ton
    if (jumpFrames >= 5) {
      stableMidiRef.current = rawMidi;
      lastMidiRef.current = rawMidi;
      jumpFramesRef.current = 0;
      return rawMidi;
    }

    // Annars: behandla som glitch → behåll gamla stableMidi
    lastMidiRef.current = rawMidi;
    jumpFramesRef.current = jumpFrames;
    return stableMidi;
  }
  
  // Aktivera mikrofon och starta pitch detection
  const handleMicToggle = async () => {
    if (micActive) {
      // Stoppa mikrofon
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop())
        micStreamRef.current = null
      }
      if (animationFrameRef.current) {
        clearTimeout(animationFrameRef.current)
      }
      setMicActive(false)
      setPitchResult({ frequency: null, clarity: 0 })
    } else {
      // Starta mikrofon
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            autoGainControl: false,
            noiseSuppression: false,
            echoCancellation: false
          }
        })
        micStreamRef.current = stream
        
        // Skapa AudioContext om den inte finns
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContext()
        }
        
        // Skapa audio nodes
        const source = audioContextRef.current.createMediaStreamSource(stream)
        const analyser = audioContextRef.current.createAnalyser()
        analyser.fftSize = 4096
        analyser.smoothingTimeConstant = 0.3
        
        source.connect(analyser)
        analyserRef.current = analyser
        
        setMicActive(true)
        
        // Starta pitch detection loop
        const detectLoop = () => {
          if (!analyserRef.current) return
          
          const buffer = new Float32Array(analyserRef.current.fftSize)
          analyserRef.current.getFloatTimeDomainData(buffer)
          
          // Get target hint if playback is active
          let targetHint: { targetMidi: number } | undefined = undefined;
          const playerIsPlaying = playerRef.current?.isPlaying() || false;
          
          if (playerIsPlaying && playerRef.current) {
            const timeline = playerRef.current['timeline'];
            if (timeline) {
              const rawNow = playerRef.current.getCurrentTime();
              const correctedNow = rawNow - latencyMsRef.current / 1000;
              
              // Find active notes from selected voice only
              let candidateNotes = timeline.notes;
              if (selectedVoiceRef.current) {
                candidateNotes = candidateNotes.filter(n => n.voice === selectedVoiceRef.current);
              }
              
              const activeNotes = candidateNotes.filter(note =>
                correctedNow >= note.startTimeSeconds &&
                correctedNow <= note.startTimeSeconds + note.durationSeconds
              );
              
              // Use first active note as target hint
              if (activeNotes.length > 0) {
                const humanNotes = activeNotes.filter(note => !note.voice.toLowerCase().includes('keyboard'));
                if (humanNotes.length > 0) {
                  targetHint = { targetMidi: humanNotes[0].midiPitch };
                }
              }
            }
          }
          
          const result = detectPitch(buffer, audioContextRef.current!.sampleRate, targetHint)
          
          setPitchResult(result)
          
          if (playerRef.current && playerIsPlaying) {
            const timeline = playerRef.current['timeline'];
            if (!timeline) return;
            
            // TIDSKÄLLA: wall-clock seconds
            const rawNow = playerRef.current.getCurrentTime();
            const correctedNow = rawNow - latencyMsRef.current / 1000;
            
            // Debug: Spara tidsinfo ALLTID (visa raw för användaren)
            setDebugTimeInfo({
              playbackTimeSeconds: rawNow,
              cursorWholeTime: 0, // Not used anymore
              cursorMeasureIndex: osmdRef.current?.cursor.Iterator.CurrentMeasureIndex || 0
            });
            
            // Filtrera på selected voice för debug och trail-ritning
            let candidateNotes = timeline.notes;
            if (selectedVoiceRef.current) {
              candidateNotes = candidateNotes.filter(n => n.voice === selectedVoiceRef.current);
            }
            
            // Räkna aktiva noter (using correctedNow)
            const tolerance = 0.05;
            const activeNotes = candidateNotes.filter(note =>
              correctedNow >= note.startTimeSeconds - tolerance &&
              correctedNow <= note.startTimeSeconds + note.durationSeconds + tolerance
            );
            
            setDebugActiveNotes(activeNotes.length);
            
            // Debug: Hitta närmaste noter ALLTID (using correctedNow)
            const allNotesSorted = [...candidateNotes]
              .sort((a, b) => Math.abs(a.startTimeSeconds - correctedNow) - Math.abs(b.startTimeSeconds - correctedNow))
              .slice(0, 10);
            
            const noteIntervals = allNotesSorted.map(note => {
              const isActive = correctedNow >= note.startTimeSeconds - tolerance && correctedNow <= note.startTimeSeconds + note.durationSeconds + tolerance;
              return {
                voice: note.voice,
                displayLabel: buildVoiceDisplayLabel(note.voice, getVoices(), partMetadata),
                pitch: midiToNoteName(note.midiPitch),
                startWhole: note.startTimeSeconds,
                endWhole: note.startTimeSeconds + note.durationSeconds,
                isActive
              };
            });
            setDebugNoteIntervals(noteIntervals);
            
            // Sätt currentTargetNote baserat på aktiva noter OCH reset stabilisering vid notbyte
            let targetMidi: number | null = null;
            let bestNote: any = null;
            
            if (activeNotes.length > 0 && selectedVoiceRef.current) {
              const humanNotes = activeNotes.filter(note => !note.voice.toLowerCase().includes('keyboard'));
              if (humanNotes.length > 0) {
                bestNote = humanNotes[0];
                const displayLabel = buildVoiceDisplayLabel(bestNote.voice, getVoices(), partMetadata);
                setCurrentTargetNote({
                  displayLabel,
                  targetMidi: bestNote.midiPitch
                });
                targetMidi = bestNote.midiPitch;
                
                // Track target note changes for grace window
                const key = makeTargetKey(bestNote);
                if (currentTargetKeyRef.current !== key) {
                  currentTargetKeyRef.current = key;
                  targetStartTimeRef.current = bestNote.startTimeSeconds;
                  targetDurationSecondsRef.current = bestNote.durationSeconds;
                  // Reset pitch stability tracking
                  stableSinceRef.current = null;
                  lastPitchMidiRef.current = null;
                  // Reset MIDI smoothing
                  stableMidiRef.current = null;
                  lastMidiRef.current = null;
                  jumpFramesRef.current = 0;
                }
                lastTargetMidiRef.current = targetMidi;
              } else {
                setCurrentTargetNote(null);
                currentTargetKeyRef.current = null;
                targetStartTimeRef.current = null;
              }
            } else {
              setCurrentTargetNote(null);
              currentTargetKeyRef.current = null;
              targetStartTimeRef.current = null;
              targetDurationSecondsRef.current = null;
              lastTargetMidiRef.current = null;
            }
            
            // Voice matching om vi har pitch
            if (result.frequency) {
              const noteInfo = frequencyToNoteInfo(result.frequency);
              if (noteInfo) {
                const rawMidi = noteInfo.exactMidi;
                const stabilizedMidi = stabilizeMidi(rawMidi);
                
                // Debug logging
                console.log(`PITCH STABILIZER raw=${rawMidi.toFixed(2)} stable=${stabilizedMidi.toFixed(2)}`);
                
                // TWO-PHASE MODEL: ATTACK vs SUSTAIN
                const targetStart = targetStartTimeRef.current;
                const timeSinceNoteStartMs = targetStart != null ? (correctedNow - targetStart) * 1000 : 0;
                const isInAttackPhase = timeSinceNoteStartMs < ATTACK_PHASE_MS;
                
                // Calculate distance to target for phase determination
                let distanceCents = 0;
                if (bestNote) {
                  distanceCents = 1200 * Math.log2(
                    midiToFrequency(stabilizedMidi) / midiToFrequency(bestNote.midiPitch)
                  );
                }
                
                // Debug phase info
                setDebugPhaseInfo({
                  phase: targetStart == null ? 'NONE' : (isInAttackPhase ? 'ATTACK' : 'SUSTAIN'),
                  timeSinceNoteStartMs,
                  distanceCents,
                  clarity: result.clarity
                });
                
                if (isInAttackPhase) {
                  // ATTACK PHASE: Pitch lock only, no quality evaluation
                  // Accept pitch if within ~150 cents (roughly correct note class)
                  const isPitchLocked = Math.abs(distanceCents) < 150;
                  
                  if (isPitchLocked) {
                    // Show match but don't evaluate quality
                    const match = findVoiceMatch(stabilizedMidi, correctedNow);
                    setVoiceMatch(match);
                  } else {
                    setVoiceMatch(null);
                  }
                  
                  // NO coloring during attack phase
                  // NO trail drawing
                  // NO scoring
                  
                } else {
                  // SUSTAIN PHASE: Quality evaluation
                  const match = findVoiceMatch(stabilizedMidi, correctedNow);
                  setVoiceMatch(match);
                  
                  // In sustain phase, we only require clarity (attack phase already handled transition)
                  const hasGoodClarity = result.clarity >= 0.4;
                  
                  // GATE: Only evaluate/draw when clarity is good
                  if (hasGoodClarity) {
                    // Rita färgspår för fel eller paus
                    if (match) {
                      // Normal matching - rita endast om avvikelse >= 10 cent
                      const absCents = Math.abs(match.distanceCents);
                      if (absCents >= 10 && trailFrameCountRef.current++ % 2 === 0) {
                        drawTrailSegment(absCents);
                      }
                    } else {
                      // Ingen match - kolla om det är paus (utanför 50ms tolerans)
                      const strictActiveNotes = candidateNotes.filter(note =>
                        correctedNow >= note.startTimeSeconds &&
                        correctedNow <= note.startTimeSeconds + note.durationSeconds
                      );
                      
                      if (strictActiveNotes.length === 0 && trailFrameCountRef.current++ % 2 === 0) {
                        // Sjunger under paus - rita orange
                        drawTrailSegment(-1); // Negativt värde = paus (orange)
                      }
                    }
                  }
                }
              } else {
                setVoiceMatch(null);
              }
            } else {
              setVoiceMatch(null);
            }
          } else {
            setVoiceMatch(null);
          }
          
          // 20 Hz sampling (50ms interval) istället för 60 Hz
          animationFrameRef.current = setTimeout(detectLoop, 50) as unknown as number
        }
        
        detectLoop()
      } catch (err) {
        console.error('Kunde inte aktivera mikrofon:', err)
        setError('Kunde inte aktivera mikrofon. Kontrollera behörigheter.')
      }
    }
  }
  
  // Hitta matchande stämma baserat på sungen pitch med tidsfönster
  const findVoiceMatch = (exactMidi: number, correctedNow: number): VoiceMatch | null => {
    if (!playerRef.current) return null;
    const timeline = playerRef.current['timeline'];
    if (!timeline) return null;
    
    // STEP 1: Filter on selected voice only (required)
    if (!selectedVoiceRef.current) {
      setDebugMatchInfo({ 
        bestVoice: null, 
        bestTargetMidi: 0, 
        bestDistanceCents: 0, 
        allDistances: [] 
      });
      return null;
    }
    
    const candidateNotes = timeline.notes.filter(n => n.voice === selectedVoiceRef.current);
    
    // STEP 2: Beräkna tempo-baserat tidsfönster
    const { sixteenth } = getBeatDurations();
    let windowPast = Math.max(0.08, sixteenth * 2);
    windowPast = Math.min(windowPast, 0.35); // Max 350ms
    const windowFuture = 0.05;
    
    // STEP 3: Hitta kandidater i tidsfönstret
    const candidatesInWindow = candidateNotes.filter(note =>
      correctedNow >= note.startTimeSeconds - windowPast &&
      correctedNow <= note.startTimeSeconds + note.durationSeconds + windowFuture
    );
    
    if (candidatesInWindow.length === 0) {
      setDebugMatchInfo({ 
        bestVoice: null, 
        bestTargetMidi: 0, 
        bestDistanceCents: 0, 
        allDistances: [] 
      });
      return null;
    }
    
    // Debug: gruppera ALLA kandidater per voice
    const notesByVoice = new Map<VoiceId, Array<{ noteName: string; midi: number }>>();
    for (const note of candidatesInWindow) {
      if (!notesByVoice.has(note.voice)) {
        notesByVoice.set(note.voice, []);
      }
      notesByVoice.get(note.voice)!.push({
        noteName: midiToNoteName(note.midiPitch),
        midi: note.midiPitch
      });
    }
    setDebugActiveNotesByVoice(notesByVoice);
    
    // STEP 4: Exclude keyboard voices
    const humanNotes = candidatesInWindow.filter(note => !note.voice.toLowerCase().includes('keyboard'));
    
    if (humanNotes.length === 0) {
      setDebugMatchInfo(null);
      return null;
    }
    
    // STEP 5: Välj bästa kandidat baserat på tid + pitch
    const wTime = 1.0;
    const wPitch = 0.015;
    
    let bestNote: typeof humanNotes[0] | null = null;
    let bestCost = Infinity;
    let bestDistanceCents = 0;
    
    for (const note of humanNotes) {
      const timeCenter = note.startTimeSeconds + note.durationSeconds / 2;
      const timeDiff = Math.abs(timeCenter - correctedNow);
      
      const pitchDiffSemitones = Math.abs(exactMidi - note.midiPitch);
      const pitchDiffCents = pitchDiffSemitones * 100;
      
      const cost = wTime * timeDiff + wPitch * pitchDiffCents;
      
      if (cost < bestCost) {
        bestCost = cost;
        bestNote = note;
        
        bestDistanceCents = 1200 * Math.log2(
          midiToFrequency(exactMidi) / midiToFrequency(note.midiPitch)
        );
      }
    }
    
    if (!bestNote) {
      setDebugMatchInfo(null);
      return null;
    }
    
    const displayLabel = buildVoiceDisplayLabel(bestNote.voice, getVoices(), partMetadata);
    
    setDebugMatchInfo({
      bestVoice: bestNote.voice,
      bestTargetMidi: bestNote.midiPitch,
      bestDistanceCents: bestDistanceCents,
      allDistances: [{ voice: bestNote.voice, targetMidi: bestNote.midiPitch, distanceCents: bestDistanceCents }]
    });
    
    return {
      voiceId: bestNote.voice,
      displayLabel,
      targetMidi: bestNote.midiPitch,
      distanceCents: bestDistanceCents
    };
  };
  
  // Initiera canvas när score container ändras
  useEffect(() => {
    if (trailCanvasRef.current && scoreContainerRef.current) {
      const canvas = trailCanvasRef.current;
      const container = scoreContainerRef.current;
      
      // Sätt canvas storlek till container storlek
      canvas.width = container.scrollWidth;
      canvas.height = container.scrollHeight;
      
      // Få rendering context
      trailCtxRef.current = canvas.getContext('2d');
    }
  }, [scoreTimeline]);
  
  // Rita färgspår bakom markören
  const drawTrailSegment = (absCents: number) => {
    if (!playheadRef.current || !trailCtxRef.current) return;
    
    const playheadLeft = parseFloat(playheadRef.current.style.left || '0');
    const playheadTop = parseFloat(playheadRef.current.style.top || '0');
    const playheadHeight = parseFloat(playheadRef.current.style.height || '0');
    
    let color: string;
    
    if (absCents < 0) {
      // Paus (negativt värde) - orange med fast transparens
      color = 'rgba(245, 158, 11, 0.6)';
    } else {
      // Normal avvikelse - röd med gradvis transparens
      // 10 cent → 0.1, 50 cent → 0.6, > 50 cent → 0.6
      const alpha = Math.min(0.6, 0.1 + (absCents - 10) * (0.5 / 40));
      color = `rgba(239, 68, 68, ${alpha})`;
    }
    
    // Rita rektangel på canvas - tät sampling för kontinuerlig linje
    const ctx = trailCtxRef.current;
    ctx.fillStyle = color;
    ctx.fillRect(playheadLeft, playheadTop, 6, playheadHeight);
    
    lastTrailPositionRef.current = playheadLeft;
  };
  
  // Rensa alla färgspår
  const clearTrail = () => {
    if (!trailCanvasRef.current || !trailCtxRef.current) return;
    const canvas = trailCanvasRef.current;
    trailCtxRef.current.clearRect(0, 0, canvas.width, canvas.height);
    lastTrailPositionRef.current = -1;
  };
  
  // Rensa färgspår till höger om markören
  const clearTrailAhead = () => {
    if (!playheadRef.current || !trailCanvasRef.current || !trailCtxRef.current) return;
    const currentLeft = parseFloat(playheadRef.current.style.left || '0');
    const canvas = trailCanvasRef.current;
    
    // Rensa allt till höger om current position
    trailCtxRef.current.clearRect(currentLeft, 0, canvas.width - currentLeft, canvas.height);
  };
  
  // Cleanup vid unmount
  useEffect(() => {
    return () => {
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop())
      }
      if (animationFrameRef.current) {
        clearTimeout(animationFrameRef.current)
      }
      clearTrail();
    }
  }, [])

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
          
          <div 
            ref={scoreContainerRef} 
            id="score-container" 
            className="score-container"
            onClick={() => {
              if (scoreTimeline && isPlaying) {
                handlePlay(); // Pausar om vi spelar
              }
            }}
            style={{ cursor: isPlaying ? 'pointer' : 'default' }}
          >
            {!osmdRef.current && <p>Välj en MusicXML- eller MXL-fil för att visa noter</p>}
            {scoreTimeline && (
              <>
                <canvas ref={trailCanvasRef} className="trail-canvas" />
                <div ref={playheadRef} className="playhead-marker" />
                
                {/* Graphical Pitch Detector Overlay */}
                {micActive && isPlaying && currentTargetNote && (
                  <div className="pitch-detector-overlay">
                    <div className="pitch-detector-content">
                      {/* Sjungen ton (störst) */}
                      <div className="sung-note">
                        {pitchResult.frequency ? (
                          (() => {
                            const noteInfo = frequencyToNoteInfo(pitchResult.frequency);
                            return noteInfo ? noteInfo.noteName : '---';
                          })()
                        ) : '---'}
                      </div>
                      
                      {/* Målton (mindre) */}
                      <div className="target-note">
                        Mål: {midiToNoteName(currentTargetNote.targetMidi)}
                      </div>
                      
                      {/* Hz och Cents */}
                      <div className="pitch-info">
                        <span className="pitch-hz">
                          {pitchResult.frequency ? `${pitchResult.frequency.toFixed(1)} Hz` : '--- Hz'}
                        </span>
                        <span className="pitch-cents">
                          {voiceMatch ? `${voiceMatch.distanceCents > 0 ? '+' : ''}${Math.round(voiceMatch.distanceCents)} cent` : '--- cent'}
                        </span>
                        <span className="pitch-clarity">
                          Clarity: {Math.round(pitchResult.clarity * 100)}%
                        </span>
                      </div>
                      
                      {/* Horisontell bar med slider */}
                      <div className="pitch-bar-container">
                        <div className="pitch-bar-labels">
                          <span className="bar-label-left">♭-50</span>
                          <span className="bar-label-center">Perfect</span>
                          <span className="bar-label-right">+50♯</span>
                        </div>
                        <div className="pitch-bar">
                          <div className="pitch-bar-track"></div>
                          {voiceMatch && (
                            <div 
                              className="pitch-bar-indicator"
                              style={{
                                left: `${Math.max(0, Math.min(100, ((voiceMatch.distanceCents + 50) / 100) * 100))}%`,
                                backgroundColor: (() => {
                                  const absCents = Math.abs(voiceMatch.distanceCents);
                                  if (absCents <= 10) return '#22c55e'; // green
                                  if (absCents >= 50) return '#ef4444'; // red
                                  // Gradient from green to red
                                  const ratio = (absCents - 10) / 40; // 0 at 10 cents, 1 at 50 cents
                                  const r = Math.round(34 + (239 - 34) * ratio);
                                  const g = Math.round(197 - (197 - 68) * ratio);
                                  const b = Math.round(94 - (94 - 68) * ratio);
                                  return `rgb(${r}, ${g}, ${b})`;
                                })()
                              }}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Overlay-kontroller */}
                {!isPlaying && (
                  <div className="score-overlay-controls">
                    <button 
                      className="overlay-play-button" 
                      onClick={handlePlay}
                      aria-label="Play"
                    >
                      ▶
                    </button>
                    {currentTime > 0 && (
                      <button 
                        className="overlay-stop-button" 
                        onClick={handleStop}
                        aria-label="Stop"
                      >
                        ■
                      </button>
                    )}
                    <div className="overlay-mic-container">
                      <button 
                        className={`overlay-mic-button ${micActive ? 'active' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (micActive) {
                            handleMicToggle();
                          } else {
                            setShowVoiceMenu(!showVoiceMenu);
                          }
                        }}
                        aria-label="Microphone"
                      >
                        🎤
                      </button>
                      
                      {/* Cirkulär stämval-meny */}
                      {showVoiceMenu && !micActive && (
                        <div className="voice-circle-menu">
                          {getVoices().filter(v => !v.toLowerCase().includes('keyboard')).map((voice, index, arr) => {
                            const angle = (index / arr.length) * 2 * Math.PI - Math.PI / 2;
                            const radius = 150;
                            const x = Math.cos(angle) * radius;
                            const y = Math.sin(angle) * radius;
                            
                            return (
                              <button
                                key={voice}
                                className="voice-circle-item"
                                style={{
                                  transform: `translate(${x}px, ${y}px)`
                                }}
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  setSelectedVoice(voice);
                                  setShowVoiceMenu(false);
                                  await handleMicToggle();
                                }}
                              >
                                {buildVoiceDisplayLabel(voice, getVoices(), partMetadata)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* Corner Controls - Speed & Mixer */}
                <div className="corner-controls">
                  <button 
                    className="corner-speed-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowSpeedSlider(!showSpeedSlider);
                      setShowMixerPanel(false);
                    }}
                    aria-label="Speed Control"
                  >
                    <div className="speed-icon-content">
                      <span className="speed-note">♩</span>
                      <span className="speed-value">{Math.round(scoreTimeline.tempoBpm * tempoMultiplier)}</span>
                    </div>
                  </button>
                  
                  <button 
                    className="corner-mixer-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMixerPanel(!showMixerPanel);
                      setShowSpeedSlider(false);
                    }}
                    aria-label="Mixer"
                  >
                    🎚️
                  </button>
                </div>
                
                {/* Speed Slider Panel */}
                {showSpeedSlider && (
                  <div className="speed-slider-panel">
                    <input
                      type="range"
                      min={0.25}
                      max={2.0}
                      step={0.05}
                      value={tempoMultiplier}
                      onChange={(e) => handleTempoChange(parseFloat(e.target.value))}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <div className="speed-presets">
                      {[0.5, 0.75, 1.0, 1.25, 1.5].map(mult => (
                        <button
                          key={mult}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleTempoChange(mult);
                          }}
                          className={tempoMultiplier === mult ? 'active' : ''}
                        >
                          {mult}x
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Mixer Panel */}
                {showMixerPanel && (
                  <div className="mixer-panel">
                    {getVoices().map(voice => {
                      const settings = getVoiceSettings(voice);
                      const displayLabel = buildVoiceDisplayLabel(voice, getVoices(), partMetadata);
                      return (
                        <div key={voice} className="mixer-voice-row">
                          <div className="mixer-voice-name">{displayLabel}</div>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={settings.volume * 100}
                            onChange={(e) => {
                              e.stopPropagation();
                              handleVoiceSettingsChange(voice, { volume: parseInt(e.target.value) / 100 });
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleVoiceSettingsChange(voice, { muted: !settings.muted });
                            }}
                            className={settings.muted ? 'active' : ''}
                          >
                            {settings.muted ? '🔇' : '🔊'}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleVoiceSettingsChange(voice, { solo: !settings.solo });
                            }}
                            className={settings.solo ? 'active' : ''}
                          >
                            S
                          </button>
                        </div>
                      );
                    })}
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
              <details>
                <summary>Stämmor ({new Set(scoreTimeline.notes.map(n => n.voice)).size})</summary>
                <ul>
                  {Array.from(new Set(scoreTimeline.notes.map(n => n.voice))).map(voice => (
                    <li key={voice}>
                      {voice}: {scoreTimeline.notes.filter(n => n.voice === voice).length} noter
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
        </div>
        
        <aside className="control-panel">
          <h3>Kontroller</h3>
          
          {/* Voice Selection for Pitch Detection */}
          {scoreTimeline && (
            <div className="voice-selection">
              <h4>🎤 Välj stämma att öva</h4>
              <select 
                value={selectedVoice || ''} 
                onChange={(e) => {
                  const newVoice = e.target.value as VoiceId;
                  setSelectedVoice(newVoice);
                }}
              >
                {!selectedVoice && <option value="">Välj stämma...</option>}
                {getVoices().filter(v => !v.toLowerCase().includes('keyboard')).map(voice => (
                  <option key={voice} value={voice}>
                    {buildVoiceDisplayLabel(voice, getVoices(), partMetadata)}
                  </option>
                ))}
              </select>
            </div>
          )}
          
          {/* Voice Matching - visas när playback är aktiv */}
          {micActive && isPlaying && scoreTimeline && (
            <div className="voice-matching">
              <h4>🎵 Stämma-identifikation</h4>
              
              {/* Visa alltid målnot när det finns aktiva noter */}
              {currentTargetNote ? (
                <div className="target-info">
                  <div className="target-voice">
                    Stämma: <strong>{currentTargetNote.displayLabel}</strong>
                  </div>
                  <div className="target-note">
                    Målnot: <strong>{midiToNoteName(currentTargetNote.targetMidi)}</strong> (MIDI {currentTargetNote.targetMidi})
                  </div>
                </div>
              ) : (
                <div className="no-target">
                  🔇 Paus - ingen målton
                </div>
              )}
              
              {/* Visa avvikelse endast när användaren sjunger OCH pitch är stabil */}
              {voiceMatch && pitchResult.frequency ? (
                (() => {
                  const targetStart = targetStartTimeRef.current;
                  const rawNow = playerRef.current?.getCurrentTime() || 0;
                  const correctedNow = rawNow - latencyMsRef.current / 1000;
                  const timeSinceNoteStartMs = targetStart != null ? (correctedNow - targetStart) * 1000 : 0;
                  const isInAttackPhase = timeSinceNoteStartMs < ATTACK_PHASE_MS;
                  
                  if (isInAttackPhase) {
                    return (
                      <div className="waiting-for-voice" style={{ color: '#999' }}>
                        Låser ton...
                      </div>
                    );
                  }
                  
                  const hasGoodClarity = pitchResult.clarity >= 0.4;
                  
                  if (!hasGoodClarity) {
                    return (
                      <div className="waiting-for-voice" style={{ color: '#999' }}>
                        Väntar på stabil ton...
                      </div>
                    );
                  }
                  
                  return (
                    <div className="voice-accuracy">
                      <div className="voice-cents" style={{
                        color: Math.abs(voiceMatch.distanceCents) < 10 ? 'green' : 
                               Math.abs(voiceMatch.distanceCents) < 25 ? 'orange' : 'red'
                      }}>
                        Avvikelse: {voiceMatch.distanceCents > 0 ? '+' : ''}{Math.round(voiceMatch.distanceCents)} cent
                      </div>
                      <div style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: '#666' }}>
                        {(() => {
                          const noteInfo = frequencyToNoteInfo(pitchResult.frequency!);
                          if (noteInfo) {
                            return `Din ton: ${noteInfo.noteName} (MIDI ${noteInfo.exactMidi.toFixed(2)})`;
                          }
                          return null;
                        })()}
                      </div>
                    </div>
                  );
                })()
              ) : currentTargetNote ? (
                <div className="waiting-for-voice">
                  Väntar på sång...
                </div>
              ) : null}
            </div>
          )}
          
          {/* Pitch Detection / Tuner */}
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
                    {(() => {
                      const noteInfo = frequencyToNoteInfo(pitchResult.frequency)
                      if (noteInfo) {
                        return (
                          <>
                            <div className="pitch-note">
                              Not: {noteInfo.noteName}
                            </div>
                            <div className="pitch-cents" style={{
                              color: Math.abs(noteInfo.centsOff) < 10 ? 'green' : 
                                     Math.abs(noteInfo.centsOff) < 25 ? 'orange' : 'red'
                            }}>
                              Avvikelse: {noteInfo.centsOff > 0 ? '+' : ''}{Math.round(noteInfo.centsOff)} cent
                            </div>
                            <div className="pitch-clarity">
                              Klarhet: {Math.round(pitchResult.clarity * 100)}%
                            </div>
                          </>
                        )
                      }
                      return null
                    })()}
                  </>
                ) : (
                  <div className="pitch-no-signal">
                    Ingen stabil pitch detekterad
                  </div>
                )}
              </div>
            )}
          </div>
          {scoreTimeline && (
            <div className="player-controls" style={{ marginTop: '20px' }}>
              <h3>Spelare</h3>
              
              <div className="transport-controls">
                <button onClick={handlePlay} disabled={!scoreTimeline}>
                  {isPlaying ? 'Pause' : 'Play'}
                </button>
                <button onClick={handleStop} disabled={!scoreTimeline}>
                  Stop
                </button>
              </div>
              
              <div className="tempo-control">
                <h4>🎵 Tempo</h4>
                <div className="tempo-display">
                  {Math.round(scoreTimeline.tempoBpm * tempoMultiplier)} BPM
                  <span className="tempo-original">({scoreTimeline.tempoBpm} BPM original)</span>
                </div>
                <div className="tempo-buttons">
                  <button onClick={() => handleTempoChange(0.5)} className={tempoMultiplier === 0.5 ? 'active' : ''}>
                    0.5x
                  </button>
                  <button onClick={() => handleTempoChange(0.75)} className={tempoMultiplier === 0.75 ? 'active' : ''}>
                    0.75x
                  </button>
                  <button onClick={() => handleTempoChange(1.0)} className={tempoMultiplier === 1.0 ? 'active' : ''}>
                    1x
                  </button>
                  <button onClick={() => handleTempoChange(1.25)} className={tempoMultiplier === 1.25 ? 'active' : ''}>
                    1.25x
                  </button>
                  <button onClick={() => handleTempoChange(1.5)} className={tempoMultiplier === 1.5 ? 'active' : ''}>
                    1.5x
                  </button>
                </div>
                <input
                  type="range"
                  min={0.25}
                  max={2.0}
                  step={0.05}
                  value={tempoMultiplier}
                  onChange={(e) => handleTempoChange(parseFloat(e.target.value))}
                  className="tempo-slider"
                />
              </div>
              
              <div className="timeline-control">
                <label>Tid: {currentTime.toFixed(1)}s / {scoreTimeline.totalDurationSeconds.toFixed(1)}s</label>
                <input
                  type="range"
                  min={0}
                  max={scoreTimeline.totalDurationSeconds}
                  step={0.1}
                  value={currentTime}
                  onChange={handleSeek}
                  className="timeline-slider"
                />
              </div>
              
              <div className="voice-mixer">
                <h4>Stämmor</h4>
                {getVoices().map(voice => {
                  const displayLabel = buildVoiceDisplayLabel(voice, getVoices(), partMetadata)
                  return (
                    <VoiceControl
                      key={voice}
                      voice={voice}
                      displayLabel={displayLabel}
                      settings={getVoiceSettings(voice)}
                      onSettingsChange={(settings) => handleVoiceSettingsChange(voice, settings)}
                    />
                  )
                })}
              </div>
            </div>
          )}
          
          {/* Latency Control */}
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
                onChange={(e) => setLatencyMs(parseInt(e.target.value, 10))}
              />
            </div>
          )}
          
          {/* DEBUG PANEL */}
          {micActive && (
            <div className="debug-panel">
              <h4>🔍 DEBUG - TIDSBAS</h4>
              
              <div className="debug-info">
                {/* Tidspositioner */}
                {debugTimeInfo ? (
                  <div className="debug-section">
                    <div className="debug-row"><strong>AKTUELL POSITION:</strong></div>
                    <div className="debug-row debug-indent">
                      PlaybackTimeSeconds = {debugTimeInfo.playbackTimeSeconds.toFixed(3)}
                    </div>
                    <div className="debug-row debug-indent">
                      CursorWholeTime = {debugTimeInfo.cursorWholeTime.toFixed(3)}
                    </div>
                    <div className="debug-row debug-indent">
                      CursorMeasure = {debugTimeInfo.cursorMeasureIndex}
                    </div>
                  </div>
                ) : (
                  <div className="debug-section">
                    <div className="debug-row"><strong>AKTUELL POSITION:</strong></div>
                    <div className="debug-row debug-indent" style={{ color: 'red' }}>
                      debugTimeInfo = NULL (cursor timestamp saknas?)
                    </div>
                  </div>
                )}
                
                <div className="debug-row">
                  <strong>Active notes count:</strong> {debugActiveNotes}
                </div>
                
                {/* Aktiva noter per voice */}
                {debugActiveNotesByVoice.size > 0 && (
                  <div className="debug-section">
                    <div className="debug-row"><strong>ACTIVE NOTES:</strong></div>
                    {Array.from(debugActiveNotesByVoice.entries()).map(([voice, notes]) => {
                      const displayLabel = buildVoiceDisplayLabel(voice, getVoices(), partMetadata);
                      return (
                        <div key={voice} className="debug-voice-block">
                          <div className="debug-row debug-indent">
                            <strong>VOICE: {displayLabel}</strong>
                          </div>
                          {notes.map((note, idx) => (
                            <div key={idx} className="debug-row debug-indent2">
                              Note: {note.noteName} (MIDI: {note.midi})
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
                
                {/* Pitch info */}
                {pitchResult.frequency && (() => {
                  const noteInfo = frequencyToNoteInfo(pitchResult.frequency);
                  if (noteInfo) {
                    return (
                      <div className="debug-section">
                        <div className="debug-row"><strong>SUNG PITCH:</strong></div>
                        <div className="debug-row debug-indent">
                          Sung note = {noteInfo.noteName}
                        </div>
                        <div className="debug-row debug-indent">
                          ExactMidi = {noteInfo.exactMidi.toFixed(2)}
                        </div>
                        <div className="debug-row debug-indent">
                          Cents = {noteInfo.centsOff > 0 ? '+' : ''}{noteInfo.centsOff.toFixed(0)}
                        </div>
                      </div>
                    );
                  }
                  return null;
                })()}
                
                {/* Noter med tidsintervall */}
                {debugNoteIntervals.length > 0 && debugTimeInfo && (
                  <div className="debug-section">
                    <div className="debug-row"><strong>NOTER MED TIDSINTERVALL:</strong></div>
                    <div className="debug-row debug-indent" style={{ fontSize: '0.75rem', color: '#999' }}>
                      (nowSeconds = {debugTimeInfo.playbackTimeSeconds.toFixed(3)})
                    </div>
                    {debugNoteIntervals.map((note, idx) => (
                      <div key={idx} className="debug-voice-block" style={{
                        backgroundColor: note.isActive ? '#d4edda' : '#fff5f5',
                        borderLeftColor: note.isActive ? '#28a745' : '#ff6b6b'
                      }}>
                        <div className="debug-row debug-indent">
                          <strong>VOICE: {note.displayLabel}</strong>
                        </div>
                        <div className="debug-row debug-indent2">
                          Pitch: {note.pitch}
                        </div>
                        <div className="debug-row debug-indent2">
                          startWhole = {note.startWhole.toFixed(3)}
                        </div>
                        <div className="debug-row debug-indent2">
                          endWhole = {note.endWhole.toFixed(3)}
                        </div>
                        <div className="debug-row debug-indent2">
                          <strong>ACTIVE = {note.isActive ? 'TRUE ✅' : 'FALSE ❌'}</strong>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                
                {/* Phase debug */}
                {debugPhaseInfo && (
                  <div className="debug-section">
                    <div className="debug-row"><strong>PHASE INFO:</strong></div>
                    <div className="debug-row debug-indent">
                      Phase = <strong>{debugPhaseInfo.phase}</strong>
                    </div>
                    <div className="debug-row debug-indent">
                      TimeSinceNoteStart = {debugPhaseInfo.timeSinceNoteStartMs.toFixed(0)} ms
                    </div>
                    <div className="debug-row debug-indent">
                      DistanceCents = {debugPhaseInfo.distanceCents.toFixed(1)}
                    </div>
                    <div className="debug-row debug-indent">
                      Clarity = {debugPhaseInfo.clarity.toFixed(2)}
                    </div>
                  </div>
                )}
                
                {/* Match debug */}
                {isPlaying && pitchResult.frequency && (
                  <div className="debug-section">
                    <div className="debug-row"><strong>MATCH RESULT:</strong></div>
                    {debugMatchInfo ? (
                      <>
                        <div className="debug-row debug-indent">
                          ClosestVoice = {debugMatchInfo.bestVoice ? buildVoiceDisplayLabel(debugMatchInfo.bestVoice, getVoices(), partMetadata) : 'null'}
                        </div>
                        <div className="debug-row debug-indent">
                          TargetPitch = {debugMatchInfo.bestTargetMidi ? midiToNoteName(debugMatchInfo.bestTargetMidi) : 'N/A'}
                        </div>
                        <div className="debug-row debug-indent">
                          DistanceCents = {debugMatchInfo.bestDistanceCents.toFixed(1)}
                        </div>
                      </>
                    ) : (
                      <div className="debug-row debug-indent">
                        MATCH = null
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>
      </main>
    </div>
  )
}

interface VoiceControlProps {
  voice: VoiceId
  displayLabel: string
  settings: VoiceMixerSettings
  onSettingsChange: (settings: Partial<VoiceMixerSettings>) => void
}

function VoiceControl({ voice, displayLabel, settings, onSettingsChange }: VoiceControlProps) {
  return (
    <div className="voice-control">
      <div className="voice-name">{displayLabel}</div>
      
      <div className="voice-volume">
        <label>Vol: {Math.round(settings.volume * 100)}%</label>
        <input
          type="range"
          min={0}
          max={100}
          value={settings.volume * 100}
          onChange={(e) => onSettingsChange({ volume: parseInt(e.target.value) / 100 })}
          className="volume-slider"
        />
      </div>
      
      <div className="voice-buttons">
        <button
          className={settings.muted ? 'active' : ''}
          onClick={() => onSettingsChange({ muted: !settings.muted })}
        >
          Mute
        </button>
        <button
          className={settings.solo ? 'active' : ''}
          onClick={() => onSettingsChange({ solo: !settings.solo })}
        >
          Solo
        </button>
      </div>
    </div>
  )
}

export default ScorePlayerPage