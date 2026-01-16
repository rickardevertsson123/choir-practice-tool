export function LatencyControl(props: {
  micActive: boolean
  latencyMs: number
  setLatencyMs: (ms: number) => void
  calibrating: boolean
  calibrationMessage: string | null
  onCalibrateSpeakers: () => void | Promise<void>
  onCalibrateHeadphones: () => void | Promise<void>
}) {
  const {
    micActive,
    latencyMs,
    setLatencyMs,
    calibrating,
    calibrationMessage,
    onCalibrateSpeakers,
    onCalibrateHeadphones
  } = props

  return (
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
      <div style={{ marginTop: 8 }}>
        {!micActive && (
          <div style={{ marginBottom: 8, opacity: 0.9 }}>
            Activate microphone to use calibration.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={onCalibrateSpeakers} disabled={calibrating || !micActive}>
            {calibrating ? 'Calibrating…' : 'Calibrate (speakers)'}
          </button>

          <button onClick={onCalibrateHeadphones} disabled={calibrating || !micActive}>
            {calibrating ? 'Calibrating…' : 'Calibrate (headphones)'}
          </button>
        </div>
        {calibrationMessage && <div style={{ marginTop: 8 }}>{calibrationMessage}</div>}
      </div>
    </div>
  )
}


