import React from 'react'
import { frequencyToNoteInfo, PitchResult } from '../../audio/pitchDetection'

export function TunerPanel(props: {
  micActive: boolean
  isPlaying: boolean
  pitchResult: PitchResult
  onMicToggle: () => void | Promise<void>
}) {
  const { micActive, isPlaying, pitchResult, onMicToggle } = props

  return (
    <div className="pitch-detector" style={{ marginTop: 16 }}>
      <h4>Tuner</h4>
      <button onClick={onMicToggle}>{micActive ? 'Deactivate microphone' : 'Activate microphone'}</button>

      {micActive && !isPlaying && (
        <div className="pitch-display">
          {pitchResult.frequency ? (
            <>
              <div className="pitch-frequency">Frequency: {pitchResult.frequency.toFixed(1)} Hz</div>
              <div className="pitch-note">Note: {frequencyToNoteInfo(pitchResult.frequency)?.noteName ?? '---'}</div>
              <div className="pitch-clarity">Clarity: {Math.round((pitchResult.clarity ?? 0) * 100)}%</div>
            </>
          ) : (
            <div className="pitch-no-signal">No stabile pitch detected</div>
          )}
        </div>
      )}
    </div>
  )
}


