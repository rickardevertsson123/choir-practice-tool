import { frequencyToNoteInfo, PitchResult } from '../../audio/pitchDetection'
import { VoiceId } from '../../types/ScoreTimeline'

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function centsToColor(distanceCents: number | null): string {
  if (distanceCents == null) return 'rgba(255,255,255,0.92)'

  // 0 cents => green, 50+ cents => red
  const t = clamp(Math.abs(distanceCents) / 50, 0, 1)

  // Tailwind-ish green/red used elsewhere in the UI
  const green = { r: 34, g: 197, b: 94 }   // #22c55e
  const red = { r: 239, g: 68, b: 68 }    // #ef4444

  const r = Math.round(lerp(green.r, red.r, t))
  const g = Math.round(lerp(green.g, red.g, t))
  const b = Math.round(lerp(green.b, red.b, t))
  return `rgb(${r}, ${g}, ${b})`
}

export type PitchDetectorOverlayProps = {
  micActive: boolean
  isPlaying: boolean
  currentTargetNote: { voice: VoiceId; midi: number; start: number; duration: number } | null
  pitchResult: PitchResult
  distanceCents: number | null
  midiToNoteName: (midi: number) => string
}

export function PitchDetectorOverlay(props: PitchDetectorOverlayProps) {
  const { micActive, currentTargetNote, pitchResult, distanceCents, midiToNoteName } = props
  // Show overlay whenever mic is active so the user can pause playback and still
  // practice holding/finding the pitch.
  if (!micActive) return null

  const sungName = pitchResult.frequency ? frequencyToNoteInfo(pitchResult.frequency)?.noteName ?? '---' : '---'

  return (
    <div className="pitch-detector-overlay">
      <div className="pitch-detector-content">
        <div className="sung-note" style={{ color: centsToColor(distanceCents) }}>
          {sungName}
        </div>
        <div className="target-note">
          {currentTargetNote
            ? `Target: ${midiToNoteName(currentTargetNote.midi)}`
            : 'Reference: nearest semitone'}
        </div>
        <div className="pitch-info">
          <span className="pitch-hz">{pitchResult.frequency ? `${pitchResult.frequency.toFixed(1)} Hz` : '--- Hz'}</span>
          <span className="pitch-cents">
            {distanceCents != null ? `${distanceCents > 0 ? '+' : ''}${Math.round(distanceCents)} cent` : '--- cent'}
            {/* Always render the bar so the overlay doesn't jump in size.
                When cents is null, hide the marker. */}
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
                  style={{
                    left: `${Math.max(0, Math.min(100, (((distanceCents ?? 0) + 50) / 100) * 100))}%`,
                    opacity: distanceCents == null ? 0 : 1
                  }}
                />
              </div>
            </div>
          </span>
          <span className="pitch-clarity">Clarity: {Math.round((pitchResult.clarity ?? 0) * 100)}%</span>
        </div>
      </div>
    </div>
  )
}


