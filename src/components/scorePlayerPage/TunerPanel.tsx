export function TunerPanel(props: {
  micActive: boolean
  onMicToggle: () => void | Promise<void>
}) {
  const { micActive, onMicToggle } = props

  return (
    <div className="pitch-detector" style={{ marginTop: 16 }}>
      <h4>Tuner</h4>
      <button onClick={onMicToggle}>{micActive ? 'Deactivate microphone' : 'Activate microphone'}</button>

      {/* Pitch visualization moved to the score overlay (PitchDetectorOverlay).
          Keep this panel as a simple mic toggle for now. */}
    </div>
  )
}


