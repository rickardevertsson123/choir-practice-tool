import { Suspense } from 'react'
import AuthClient from './AuthClient'

export default function AuthPage() {
  return (
    <Suspense fallback={<div style={{ padding: 16 }}>Loading…</div>}>
      <AuthClient />
    </Suspense>
  )
}


