import { useRef, useEffect, useState } from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import JSZip from 'jszip'
import { ScoreTimeline, VoiceId } from '../types/ScoreTimeline'
import { buildScoreTimelineFromMusicXml, extractPartMetadata, buildVoiceDisplayLabel, PartMetadata } from '../utils/musicXmlParser'
import { ScorePlayer, VoiceMixerSettings, midiToFrequency } from '../audio/ScorePlayer'
import { detectPitch, frequencyToNoteInfo, PitchResult } from '../audio/pitchDetection'
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
        osmdRef.current.render()
        
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
    if (!playerRef.current) return

    const updateTime = () => {
      if (playerRef.current) {
        setCurrentTime(playerRef.current.getCurrentTime())
        setIsPlaying(playerRef.current.isPlaying())
      }
    }

    const interval = setInterval(updateTime, 100)
    return () => clearInterval(interval)
  }, [scoreTimeline])

  // Playhead animation loop med OSMD Cursor (musical-time baserad)
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

      // Hitta närmaste cursor step baserat på musical time
      let targetStep = 0
      for (let i = 0; i < cursorStepsRef.current.length; i++) {
        if (cursorStepsRef.current[i].musicalTime <= musicalTime) {
          targetStep = cursorStepsRef.current[i].step
        } else {
          break
        }
      }

      // Flytta cursor endast om steget ändrats
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

      // Synka overlay-linje med OSMD cursor
      const cursorElement = osmdRef.current.cursor.cursorElement
      if (cursorElement) {
        const cursorRect = cursorElement.getBoundingClientRect()
        const containerRect = scoreContainerRef.current.getBoundingClientRect()

        playheadRef.current.style.left = `${cursorRect.left - containerRect.left + scoreContainerRef.current.scrollLeft}px`
        playheadRef.current.style.top = `${cursorRect.top - containerRect.top + scoreContainerRef.current.scrollTop}px`
        playheadRef.current.style.height = `${cursorRect.height}px`

        // Auto-scroll
        if (playerRef.current.isPlaying() && cursorRect.bottom > containerRect.bottom - 80) {
          cursorElement.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
          })
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
      }
      playerRef.current.play()
    }
  }

  const handleStop = () => {
    if (!playerRef.current || !osmdRef.current) return
    playerRef.current.stop()
    osmdRef.current.cursor.reset()
    osmdRef.current.cursor.update()
  }

  const handleSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(event.target.value)
    setCurrentTime(time)
    if (playerRef.current && osmdRef.current) {
      playerRef.current.seekTo(time)
      // Cursor uppdateras i animation loop
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
          
          const result = detectPitch(buffer, audioContextRef.current!.sampleRate)
          setPitchResult(result)
          
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
            {scoreTimeline && <div ref={playheadRef} className="playhead-marker" />}
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
          
          {/* Pitch Detection / Tuner */}
          <div className="pitch-detector">
            <h4>Tuner</h4>
            <button onClick={handleMicToggle}>
              {micActive ? 'Stoppa mikrofon' : 'Aktivera mikrofon'}
            </button>
            
            {micActive && (
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