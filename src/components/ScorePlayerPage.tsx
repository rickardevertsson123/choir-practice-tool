import { useRef, useEffect, useState } from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import JSZip from 'jszip'
import { ScoreTimeline, VoiceId } from '../types/ScoreTimeline'
import { buildScoreTimelineFromMusicXml, extractPartMetadata, buildVoiceDisplayLabel, PartMetadata } from '../utils/musicXmlParser'
import { ScorePlayer, VoiceMixerSettings, midiToFrequency } from '../audio/ScorePlayer'
import { detectPitch, frequencyToNoteInfo, PitchResult, TargetHint } from '../audio/pitchDetection'
import './ScorePlayerPage.css'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToNoteName(midi: number): string {
  const noteIndex = midi % 12;
  const octave = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[noteIndex] + octave;
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
  
  // Reference tone state
  const [referenceMidi, setReferenceMidi] = useState(69) // A4
  const [isRefPlaying, setIsRefPlaying] = useState(false)
  const refOscillatorRef = useRef<OscillatorNode | null>(null)
  const refGainRef = useRef<GainNode | null>(null)
  
  // Voice matching state
  interface VoiceMatch {
    voiceId: VoiceId;
    displayLabel: string;
    targetMidi: number;
    distanceCents: number;
  }
  const [voiceMatch, setVoiceMatch] = useState<VoiceMatch | null>(null)
  
  // Selected voice for pitch detection
  const [selectedVoice, setSelectedVoice] = useState<VoiceId | 'auto'>('auto')
  const selectedVoiceRef = useRef<VoiceId | 'auto'>('auto')
  
  // Tempo control
  const [tempoMultiplier, setTempoMultiplier] = useState(1.0)
  
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
          followCursor: true,
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

      // Auto-scroll
      const cursorElement = osmdRef.current.cursor.cursorElement;
      if (cursorElement && playerRef.current.isPlaying()) {
        const cursorRect = cursorElement.getBoundingClientRect();
        const containerRect = scoreContainerRef.current.getBoundingClientRect();
        
        if (cursorRect.bottom > containerRect.bottom - 80) {
          cursorElement.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
          });
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
  
  // Aktivera mikrofon och starta pitch detection
  const handleMicToggle = async () => {
    if (micActive) {
      // Stoppa mikrofon
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop())
        micStreamRef.current = null
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      setMicActive(false)
      setPitchResult({ frequency: null, clarity: 0 })
    } else {
      // Starta mikrofon
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        micStreamRef.current = stream
        
        // Skapa AudioContext om den inte finns
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContext()
        }
        
        // Skapa audio nodes
        const source = audioContextRef.current.createMediaStreamSource(stream)
        const analyser = audioContextRef.current.createAnalyser()
        analyser.fftSize = 4096
        analyser.smoothingTimeConstant = 0.8
        
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
              const nowSeconds = playerRef.current.getCurrentTime();
              
              // Find active notes
              let candidateNotes = timeline.notes;
              if (selectedVoiceRef.current !== 'auto') {
                candidateNotes = candidateNotes.filter(n => n.voice === selectedVoiceRef.current);
              }
              
              const activeNotes = candidateNotes.filter(note =>
                nowSeconds >= note.startTimeSeconds &&
                nowSeconds <= note.startTimeSeconds + note.durationSeconds
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
            const nowSeconds = playerRef.current.getCurrentTime();
            
            // Debug: Spara tidsinfo ALLTID
            setDebugTimeInfo({
              playbackTimeSeconds: nowSeconds,
              cursorWholeTime: 0, // Not used anymore
              cursorMeasureIndex: osmdRef.current?.cursor.Iterator.CurrentMeasureIndex || 0
            });
            
            // Räkna aktiva noter (using SECONDS)
            const activeNotes = timeline.notes.filter(note =>
              nowSeconds >= note.startTimeSeconds &&
              nowSeconds <= note.startTimeSeconds + note.durationSeconds
            );
            
            setDebugActiveNotes(activeNotes.length);
            
            // Debug: Hitta närmaste noter ALLTID
            const allNotesSorted = [...timeline.notes]
              .sort((a, b) => Math.abs(a.startTimeSeconds - nowSeconds) - Math.abs(b.startTimeSeconds - nowSeconds))
              .slice(0, 10);
            
            const noteIntervals = allNotesSorted.map(note => {
              const isActive = nowSeconds >= note.startTimeSeconds && nowSeconds <= note.startTimeSeconds + note.durationSeconds;
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
            
            // Voice matching om vi har pitch
            if (result.frequency) {
              const noteInfo = frequencyToNoteInfo(result.frequency);
              if (noteInfo) {
                const match = findVoiceMatch(noteInfo.exactMidi);
                setVoiceMatch(match);
                
                // Rita färgspår ENDAST när vi missar (orange/röd)
                const absCents = Math.abs(match.distanceCents);
                if (match && absCents >= 10 && trailFrameCountRef.current++ % 8 === 0) {
                  drawTrailSegment(absCents);
                }
              } else {
                setVoiceMatch(null);
              }
            }
          } else {
            setVoiceMatch(null);
          }
          
          animationFrameRef.current = requestAnimationFrame(detectLoop)
        }
        
        detectLoop()
      } catch (err) {
        console.error('Kunde inte aktivera mikrofon:', err)
        setError('Kunde inte aktivera mikrofon. Kontrollera behörigheter.')
      }
    }
  }
  
  // Spela referenston
  const playReferenceTone = () => {
    if (isRefPlaying) {
      // Stoppa ton
      if (refOscillatorRef.current && refGainRef.current) {
        const now = audioContextRef.current!.currentTime;
        refGainRef.current.gain.setTargetAtTime(0, now, 0.05); // Fade out
        setTimeout(() => {
          refOscillatorRef.current?.stop();
          refOscillatorRef.current = null;
          refGainRef.current = null;
        }, 200);
      }
      setIsRefPlaying(false);
    } else {
      // Starta ton
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext();
      }
      
      const osc = audioContextRef.current.createOscillator();
      const gain = audioContextRef.current.createGain();
      
      osc.type = 'sine';
      osc.frequency.value = midiToFrequency(referenceMidi);
      
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(audioContextRef.current.destination);
      
      const now = audioContextRef.current.currentTime;
      gain.gain.setTargetAtTime(0.3, now, 0.02); // Fade in
      
      osc.start(now);
      
      refOscillatorRef.current = osc;
      refGainRef.current = gain;
      setIsRefPlaying(true);
      
      // Auto-stop efter 2.5 sekunder
      setTimeout(() => {
        if (refGainRef.current && refOscillatorRef.current) {
          const stopTime = audioContextRef.current!.currentTime;
          refGainRef.current.gain.setTargetAtTime(0, stopTime, 0.05);
          setTimeout(() => {
            refOscillatorRef.current?.stop();
            refOscillatorRef.current = null;
            refGainRef.current = null;
            setIsRefPlaying(false);
          }, 200);
        }
      }, 2500);
    }
  };
  
  // Helper: Find closest octave of target to sung pitch
  const findClosestOctaveTarget = (sungMidi: number, targetMidi: number): number => {
    let bestTarget = targetMidi;
    let bestDist = Math.abs(sungMidi - targetMidi);

    // Try octaves from -4 to +4 (covers full human range)
    for (let k = -4; k <= 4; k++) {
      const candidate = targetMidi + 12 * k;
      const dist = Math.abs(sungMidi - candidate);

      if (dist < bestDist) {
        bestTarget = candidate;
        bestDist = dist;
      }
    }

    return bestTarget;
  };

  // Hitta matchande stämma baserat på sungen pitch
  const findVoiceMatch = (exactMidi: number, voiceFilter?: VoiceId): VoiceMatch | null => {
    if (!playerRef.current) return null;
    const timeline = playerRef.current['timeline'];
    if (!timeline) return null;
    
    // STEP 0: Get current time in SECONDS (wall-clock time)
    const nowSeconds = playerRef.current.getCurrentTime();
    
    // STEP 1: Filter on voice only
    let candidateNotes = timeline.notes;
    if (selectedVoiceRef.current !== 'auto') {
      candidateNotes = candidateNotes.filter(n => n.voice === selectedVoiceRef.current);
    }
    
    // STEP 2: FILTER ON CURRENT TIME (CRITICAL)
    // Use startTimeSeconds and durationSeconds (NOT startWhole/endWhole)
    const activeNotes = candidateNotes.filter(note =>
      nowSeconds >= note.startTimeSeconds &&
      nowSeconds <= note.startTimeSeconds + note.durationSeconds
    );
    
    // STEP 3: NO MATCH IF EMPTY
    if (activeNotes.length === 0) {
      setDebugMatchInfo(null);
      return null;
    }
    
    // Debug: gruppera ALLA aktiva noter per voice
    const notesByVoice = new Map<VoiceId, Array<{ noteName: string; midi: number }>>();
    for (const note of activeNotes) {
      if (!notesByVoice.has(note.voice)) {
        notesByVoice.set(note.voice, []);
      }
      notesByVoice.get(note.voice)!.push({
        noteName: midiToNoteName(note.midiPitch),
        midi: note.midiPitch
      });
    }
    setDebugActiveNotesByVoice(notesByVoice);
    
    // STEP 4: Pitch match ONLY within activeNotes
    // Exclude keyboard voices
    const humanNotes = activeNotes.filter(note => !note.voice.toLowerCase().includes('keyboard'));
    
    if (humanNotes.length === 0) {
      setDebugMatchInfo(null);
      return null;
    }
    
    // Find closest note by pitch class (allowing octave transposition)
    let bestNote: typeof humanNotes[0] | null = null;
    let bestDistance = Infinity;
    
    for (const note of humanNotes) {
      // Calculate distance modulo 12 (pitch class distance)
      const sungPC = ((exactMidi % 12) + 12) % 12;
      const targetPC = ((note.midiPitch % 12) + 12) % 12;
      const diff = sungPC - targetPC;
      // Normalize to [-6, +6] semitones range (shortest path around circle)
      let normalizedDiff = diff;
      if (diff > 6) normalizedDiff = diff - 12;
      if (diff < -6) normalizedDiff = diff + 12;
      const distanceCents = Math.abs(normalizedDiff * 100);
      
      if (distanceCents < bestDistance) {
        bestDistance = distanceCents;
        bestNote = note;
      }
    }
    
    if (!bestNote) {
      setDebugMatchInfo(null);
      return null;
    }
    
    // OCTAVE-AWARE MATCHING: Find closest octave of target to sung pitch
    const targetMidiRaw = bestNote.midiPitch;
    const targetMidiOctaveAdj = findClosestOctaveTarget(exactMidi, targetMidiRaw);
    
    // Calculate cents using octave-adjusted target
    const distanceCents = 1200 * Math.log2(
      midiToFrequency(exactMidi) / midiToFrequency(targetMidiOctaveAdj)
    );
    
    const displayLabel = buildVoiceDisplayLabel(bestNote.voice, getVoices(), partMetadata);
    
    setDebugMatchInfo({
      bestVoice: bestNote.voice,
      bestTargetMidi: targetMidiOctaveAdj,
      bestDistanceCents: distanceCents,
      allDistances: [{ voice: bestNote.voice, targetMidi: targetMidiOctaveAdj, distanceCents }]
    });
    
    return {
      voiceId: bestNote.voice,
      displayLabel,
      targetMidi: targetMidiOctaveAdj,
      distanceCents
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
    
    // Bestäm färg baserat på cents (mer transparent)
    let color = 'rgba(239, 68, 68, 0.15)'; // Röd (bad)
    if (absCents < 10) {
      color = 'rgba(34, 197, 94, 0.15)'; // Grön (good)
    } else if (absCents < 25) {
      color = 'rgba(245, 158, 11, 0.15)'; // Orange (close)
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
        cancelAnimationFrame(animationFrameRef.current)
      }
      if (refOscillatorRef.current) {
        refOscillatorRef.current.stop();
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
          >
            {!osmdRef.current && <p>Välj en MusicXML- eller MXL-fil för att visa noter</p>}
            {scoreTimeline && (
              <>
                <canvas ref={trailCanvasRef} className="trail-canvas" />
                <div ref={playheadRef} className="playhead-marker" />
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
                value={selectedVoice} 
                onChange={(e) => {
                  const newVoice = e.target.value as VoiceId | 'auto';
                  setSelectedVoice(newVoice);
                  selectedVoiceRef.current = newVoice;
                }}
              >
                <option value="auto">Auto (alla stämmor)</option>
                {getVoices().filter(v => !v.toLowerCase().includes('keyboard')).map(voice => (
                  <option key={voice} value={voice}>
                    {buildVoiceDisplayLabel(voice, getVoices(), partMetadata)}
                  </option>
                ))}
              </select>
            </div>
          )}
          
          {/* Reference Tone Trainer */}
          <div className="reference-tone">
            <h4>🔔 Referenston-träning</h4>
            
            <div className="reference-controls">
              <button 
                onClick={() => setReferenceMidi(Math.max(48, referenceMidi - 1))}
                className="ref-adjust"
              >
                –
              </button>
              <div className="ref-note-display">
                {midiToNoteName(referenceMidi)}
              </div>
              <button 
                onClick={() => setReferenceMidi(Math.min(84, referenceMidi + 1))}
                className="ref-adjust"
              >
                +
              </button>
            </div>
            
            <button 
              onClick={playReferenceTone}
              className="ref-play-button"
              style={{ backgroundColor: isRefPlaying ? '#dc3545' : '#28a745' }}
            >
              {isRefPlaying ? 'Stoppa ton' : 'Spela referenston'}
            </button>
          </div>
          
          {/* Voice Matching - visas endast när playback är aktiv */}
          {micActive && isPlaying && scoreTimeline && (
            <div className="voice-matching">
              <h4>🎵 Stämma-identifikation</h4>
              {voiceMatch ? (
                <div className="voice-match-display">
                  <div className="matched-voice">
                    Sjunger stämma: <strong>{voiceMatch.displayLabel}</strong> ✅
                  </div>
                  <div className="target-note">
                    Målnot: {midiToNoteName(voiceMatch.targetMidi)} (MIDI {voiceMatch.targetMidi})
                  </div>
                  <div className="voice-cents" style={{
                    color: Math.abs(voiceMatch.distanceCents) < 10 ? 'green' : 
                           Math.abs(voiceMatch.distanceCents) < 25 ? 'orange' : 'red'
                  }}>
                    Avvikelse: {voiceMatch.distanceCents > 0 ? '+' : ''}{Math.round(voiceMatch.distanceCents)} cent
                  </div>
                  <div style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: '#666', minHeight: '1.5rem' }}>
                    {pitchResult.frequency && (() => {
                      const noteInfo = frequencyToNoteInfo(pitchResult.frequency);
                      if (noteInfo) {
                        return `Din ton: ${noteInfo.noteName} (MIDI ${noteInfo.exactMidi.toFixed(2)})`;
                      }
                      return '\u00A0'; // Non-breaking space as placeholder
                    })()}
                  </div>
                </div>
              ) : (
                <div className="no-voice-match">
                  {pitchResult.frequency ? 'Ingen tydlig stämma' : 'Väntar på sång...'}
                </div>
              )}
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
                        // Beräkna avvikelse relativt referenston
                        const refCents = (noteInfo.midi - referenceMidi) * 100 + noteInfo.centsOff;
                        
                        return (
                          <>
                            <div className="pitch-target">
                              Målton: {midiToNoteName(referenceMidi)}
                            </div>
                            <div className="pitch-note">
                              Din ton: {noteInfo.noteName}
                            </div>
                            <div className="pitch-cents" style={{
                              color: Math.abs(refCents) < 10 ? 'green' : 
                                     Math.abs(refCents) < 25 ? 'orange' : 'red'
                            }}>
                              Avvikelse: {refCents > 0 ? '+' : ''}{Math.round(refCents)} cent
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