import { useRef, useEffect, useState } from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import JSZip from 'jszip'
import { ScoreTimeline, VoiceId } from '../types/ScoreTimeline'
import { buildScoreTimelineFromMusicXml } from '../utils/musicXmlParser'
import { ScorePlayer, VoiceMixerSettings } from '../audio/ScorePlayer'
import './ScorePlayerPage.css'

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
  const cursorStepsRef = useRef<Array<{ step: number; musicalTime: number }>>([])
  const playerRef = useRef<ScorePlayer | null>(null)

  // Initiera OSMD när komponenten mountas
  useEffect(() => {
    if (scoreContainerRef.current && !osmdRef.current) {
      try {
        osmdRef.current = new OpenSheetMusicDisplay(scoreContainerRef.current, {
          autoResize: true,
          backend: 'svg'
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
      
      // Bygg ScoreTimeline
      const timeline = await buildScoreTimelineFromMusicXml(xmlContent)
      
      // Debug: Verifiera Rehearsal keyboard noter
      const keyboardNotes = timeline.notes
        .filter(n => n.voice === "Rehearsal keyboard")
        .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds)
        .slice(0, 15);
      
      console.log("First Rehearsal keyboard notes:", keyboardNotes.map(n => ({
        start: n.startTimeSeconds.toFixed(2),
        duration: n.durationSeconds.toFixed(2),
        midi: n.midiPitch,
      })));
      
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
      
      // Leta efter score.xml eller liknande XML-fil
      const xmlFile = zip.file('score.xml') || 
                     Object.values(zip.files).find(f => f.name.endsWith('.xml') && !f.dir)
      
      if (!xmlFile) {
        throw new Error('Ingen XML-fil hittades i MXL-arkivet')
      }
      
      return await xmlFile.async('text')
    } else {
      // Hantera vanliga XML-filer
      return await file.text()
    }
  }

  // Skapa ScorePlayer när timeline ändras
  useEffect(() => {
    if (scoreTimeline) {
      if (playerRef.current) {
        playerRef.current.dispose()
      }
      try {
        playerRef.current = new ScorePlayer(scoreTimeline)
        
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
  }, [scoreTimeline])

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
          <p>Kontroller kommer här</p>
          {scoreTimeline && (
            <div className="player-controls">
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
                {getVoices().map(voice => (
                  <VoiceControl
                    key={voice}
                    voice={voice}
                    settings={getVoiceSettings(voice)}
                    onSettingsChange={(settings) => handleVoiceSettingsChange(voice, settings)}
                  />
                ))}
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
  settings: VoiceMixerSettings
  onSettingsChange: (settings: Partial<VoiceMixerSettings>) => void
}

function VoiceControl({ voice, settings, onSettingsChange }: VoiceControlProps) {
  return (
    <div className="voice-control">
      <div className="voice-name">{voice}</div>
      
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