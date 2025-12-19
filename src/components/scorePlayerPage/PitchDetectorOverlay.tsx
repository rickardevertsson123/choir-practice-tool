import React from 'react'
import { frequencyToNoteInfo, PitchResult } from '../../audio/pitchDetection'
import { VoiceId } from '../../types/ScoreTimeline'

export function PitchDetectorOverlay(props: {
  micActive: boolean
  isPlaying: boolean
  currentTargetNote: { voice: VoiceId; midi: number; start: number; duration: number } | null
  pitchResult: PitchResult
  distanceCents: number | null
  midiToNoteName: (midi: number) => string
}) {
  const { micActive, isPlaying, currentTargetNote, pitchResult, distanceCents, midiToNoteName } = props
  if (!micActive || !isPlaying || !currentTargetNote) return null

  const sungName = pitchResult.frequency ? frequencyToNoteInfo(pitchResult.frequency)?.noteName ?? '---' : '---'

  return (
    <div className="pitch-detector-overlay">
      <div className="pitch-detector-content">
        <div className="sung-note">{sungName}</div>
        <div className="target-note">Mål: {midiToNoteName(currentTargetNote.midi)}</div>
        <div className="pitch-info">
          <span className="pitch-hz">{pitchResult.frequency ? `${pitchResult.frequency.toFixed(1)} Hz` : '--- Hz'}</span>
          <span className="pitch-cents">
            {distanceCents != null ? `${distanceCents > 0 ? '+' : ''}${Math.round(distanceCents)} cent` : '--- cent'}
            {distanceCents != null && (
              <div className="cents-bar">
                <div className="cents-bar__labels">
                  <span>-50</span>
                  <span>Perfect</span>
                  <span>+50</span>
                </div>

                <div className="cents-bar__track">
                  <div className="cents-bar__center" />
                  <div
                    className="cents-bar__marker"
                    style={{ left: `${Math.max(0, Math.min(100, ((distanceCents + 50) / 100) * 100))}%` }}
                  />
                </div>
              </div>
            )}
          </span>
          <span className="pitch-clarity">Clarity: {Math.round((pitchResult.clarity ?? 0) * 100)}%</span>
        </div>
      </div>
    </div>
  )
}


