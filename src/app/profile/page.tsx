'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSupabaseBrowser } from '../../lib/supabaseBrowser'

export default function ProfilePage() {
  const router = useRouter()
  const supabase = useMemo(() => getSupabaseBrowser(), [])
  const [email, setEmail] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)

  const [displayName, setDisplayName] = useState('')
  const [displayBusy, setDisplayBusy] = useState(false)
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [pwBusy, setPwBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      const s = data.session
      if (!s?.user) {
        router.replace('/auth')
        return
      }
      setUserId(s.user.id)
      setEmail(s.user.email ?? null)
      setToken(s.access_token)
    })
    return () => {
      cancelled = true
    }
  }, [router, supabase])

  useEffect(() => {
    let cancelled = false
    async function loadProfile() {
      if (!userId) return
      setError(null)
      try {
        const { data, error } = await supabase.from('profiles').select('display_name').eq('id', userId).maybeSingle()
        if (error) throw error
        if (!cancelled) setDisplayName(data?.display_name ?? '')
      } catch {
        // ignore (schema might not be applied yet)
      }
    }
    loadProfile()
    return () => {
      cancelled = true
    }
  }, [supabase, userId])

  async function saveDisplayName() {
    if (!userId) return
    setError(null)
    setStatus(null)
    const name = displayName.trim()
    if (name.length > 80) {
      setError('Display name is too long (max 80 characters).')
      return
    }

    setDisplayBusy(true)
    try {
      const { error } = await supabase.from('profiles').upsert({ id: userId, email: email ?? null, display_name: name || null })
      if (error) throw error
      setStatus('Profile saved.')
    } catch (e: any) {
      setError(e?.message ? String(e.message) : 'Failed to save profile')
    } finally {
      setDisplayBusy(false)
    }
  }

  async function changePassword() {
    setError(null)
    setStatus(null)
    if (!pw1 || pw1.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (pw1 !== pw2) {
      setError('Passwords do not match.')
      return
    }
    setPwBusy(true)
    try {
      const { error } = await supabase.auth.updateUser({ password: pw1 })
      if (error) throw error
      setPw1('')
      setPw2('')
      setStatus('Password updated.')
    } catch (e: any) {
      setError(e?.message ? String(e.message) : 'Failed to update password')
    } finally {
      setPwBusy(false)
    }
  }

  async function deleteAccount() {
    if (!token) return
    setError(null)
    setStatus(null)

    const ok = confirm(
      'This will permanently delete your account, remove you from all groups, and delete any groups you created. Continue?'
    )
    if (!ok) return

    setBusy(true)
    try {
      const r = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)

      await supabase.auth.signOut()
      setStatus('Account deleted.')
      router.replace('/')
    } catch (e: any) {
      setError(e?.message ? String(e.message) : 'Failed to delete account')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 820, margin: '40px auto', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#111827' }}>Profile</div>
          <div style={{ color: '#6b7280', marginTop: 6 }}>Signed in as: {email ?? '—'}</div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <a href="/groups">Home</a>
        </div>
      </div>

      <div style={{ marginTop: 16, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18 }}>
        <div style={{ fontWeight: 700, color: '#111827' }}>Display name</div>
        <div style={{ color: '#6b7280', marginTop: 6 }}>This name will be shown to other members in your groups.</div>
        <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name (e.g. Rickard)"
            style={{ height: 40, borderRadius: 10, border: '1px solid #d1d5db', padding: '0 12px', minWidth: 280 }}
          />
          <button
            onClick={saveDisplayName}
            disabled={displayBusy || !userId}
            style={{
              height: 40,
              padding: '0 14px',
              borderRadius: 10,
              border: '1px solid #111827',
              background: '#111827',
              color: '#fff',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {displayBusy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18 }}>
        <div style={{ fontWeight: 700, color: '#111827' }}>Change password</div>
        <div style={{ color: '#6b7280', marginTop: 6 }}>Choose a new password for your account.</div>
        <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={pw1}
            onChange={(e) => setPw1(e.target.value)}
            type="password"
            placeholder="New password"
            style={{ height: 40, borderRadius: 10, border: '1px solid #d1d5db', padding: '0 12px', minWidth: 220 }}
          />
          <input
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            type="password"
            placeholder="Repeat new password"
            style={{ height: 40, borderRadius: 10, border: '1px solid #d1d5db', padding: '0 12px', minWidth: 220 }}
          />
          <button
            onClick={changePassword}
            disabled={pwBusy}
            style={{
              height: 40,
              padding: '0 14px',
              borderRadius: 10,
              border: '1px solid #111827',
              background: '#111827',
              color: '#fff',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {pwBusy ? 'Updating…' : 'Update password'}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18 }}>
        <div style={{ fontWeight: 700, color: '#111827' }}>Danger zone</div>
        <div style={{ color: '#6b7280', marginTop: 6 }}>
          Delete your account. This is permanent.
        </div>
        <div style={{ marginTop: 12 }}>
          <button
            onClick={deleteAccount}
            disabled={busy || !token}
            style={{
              height: 40,
              padding: '0 14px',
              borderRadius: 10,
              border: '1px solid rgba(239, 68, 68, 0.35)',
              background: 'rgba(239, 68, 68, 0.10)',
              color: '#991b1b',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {busy ? 'Deleting…' : 'Delete my account'}
          </button>
        </div>

      </div>

      {error && <div style={{ marginTop: 12, color: '#991b1b', fontWeight: 700 }}>{error}</div>}
      {status && <div style={{ marginTop: 12, color: '#166534', fontWeight: 700 }}>{status}</div>}
    </div>
  )
}


