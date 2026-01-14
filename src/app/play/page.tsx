import { Suspense } from 'react'
import ScorePlayerPage from '../../components/ScorePlayerPage'

export default function PlayPage() {
  return (
    <Suspense fallback={<div style={{ padding: 16 }}>Loading…</div>}>
      <ScorePlayerPage />
    </Suspense>
  )
}


