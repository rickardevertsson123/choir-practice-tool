export type PerfSnapshot = {
  iter: number
  avgLoop: number
  minLoop: number
  maxLoop: number
  lastLoop: number
  avgDetect: number
  minDetect: number
  maxDetect: number
  lastDetect: number
  skipped: number
}

export function PerfOverlay(props: { perfSnapshot: PerfSnapshot | null; micActive: boolean }) {
  const { perfSnapshot, micActive } = props
  if (!perfSnapshot || !micActive) return null

  return (
    <div
      style={{
        position: 'fixed',
        right: 12,
        bottom: 12,
        background: 'rgba(0,0,0,0.7)',
        color: 'white',
        padding: 8,
        borderRadius: 6,
        fontSize: 12,
        zIndex: 2000
      }}
    >
      <div>
        perf: iter {perfSnapshot.iter} skipped {perfSnapshot.skipped}
      </div>
      <div>
        loop ms: last {perfSnapshot.lastLoop} min {perfSnapshot.minLoop} avg {perfSnapshot.avgLoop} max {perfSnapshot.maxLoop}
      </div>
      <div>
        detect ms: last {perfSnapshot.lastDetect} min {perfSnapshot.minDetect} avg {perfSnapshot.avgDetect} max {perfSnapshot.maxDetect}
      </div>
    </div>
  )
}


