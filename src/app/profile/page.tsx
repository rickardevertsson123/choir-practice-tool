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
  const [avatarPath, setAvatarPath] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [avatarBusy, setAvatarBusy] = useState(false)
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
        const { data, error } = await supabase.from('profiles').select('display_name,avatar_path').eq('id', userId).maybeSingle()
        if (error) throw error
        if (!cancelled) {
          setDisplayName(data?.display_name ?? '')
          setAvatarPath(data?.avatar_path ?? null)
        }
      } catch {
        // ignore (schema might not be applied yet)
      }
    }
    loadProfile()
    return () => {
      cancelled = true
    }
  }, [supabase, userId])

  useEffect(() => {
    let cancelled = false
    async function loadAvatarUrl() {
      setAvatarUrl(null)
      if (!avatarPath) return
      try {
        const { data, error } = await supabase.storage.from('user-avatars').createSignedUrl(avatarPath, 60 * 60)
        if (error) throw error
        if (!cancelled) setAvatarUrl(data?.signedUrl ?? null)
      } catch {
        // ignore
      }
    }
    loadAvatarUrl()
    return () => {
      cancelled = true
    }
  }, [avatarPath, supabase])

  async function compressAvatarToWebp(file: File): Promise<Blob> {
    const TARGET = 256

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onerror = () => reject(new Error('Failed to read file'))
      r.onload = () => resolve(String(r.result))
      r.readAsDataURL(file)
    })

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('Failed to decode image'))
      i.src = dataUrl
    })

    const canvas = document.createElement('canvas')
    canvas.width = TARGET
    canvas.height = TARGET
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas not supported')

    const srcW = img.naturalWidth
    const srcH = img.naturalHeight
    const size = Math.min(srcW, srcH)
    const sx = Math.round((srcW - size) / 2)
    const sy = Math.round((srcH - size) / 2)

    ctx.fillStyle = '#111827'
    ctx.fillRect(0, 0, TARGET, TARGET)
    ctx.drawImage(img, sx, sy, size, size, 0, 0, TARGET, TARGET)

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => {
          if (!b) reject(new Error('Failed to encode image'))
          else resolve(b)
        },
        'image/webp',
        0.82
      )
    })
    return blob
  }

  async function uploadAvatar(file: File) {
    if (!userId) return
    setError(null)
    setStatus(null)
    setAvatarBusy(true)
    try {
      const blob = await compressAvatarToWebp(file)
      const path = `${userId}/avatar.webp`

      const { error: upErr } = await supabase.storage.from('user-avatars').upload(path, blob, {
        upsert: true,
        contentType: 'image/webp',
      })
      if (upErr) throw upErr

      const { error: dbErr } = await supabase
        .from('profiles')
        .upsert({ id: userId, email: email ?? null, avatar_path: path })
      if (dbErr) throw dbErr

      setAvatarPath(path)
      setStatus('Avatar updated.')
    } catch (e: any) {
      setError(e?.message ? String(e.message) : 'Failed to upload avatar')
    } finally {
      setAvatarBusy(false)
    }
  }

  async function removeAvatar() {
    if (!userId) return
    const ok = confirm('Remove your avatar?')
    if (!ok) return
    setError(null)
    setStatus(null)
    setAvatarBusy(true)
    try {
      const path = avatarPath || `${userId}/avatar.webp`
      await supabase.storage.from('user-avatars').remove([path])
      const { error: dbErr } = await supabase
        .from('profiles')
        .upsert({ id: userId, email: email ?? null, avatar_path: null })
      if (dbErr) throw dbErr
      setAvatarPath(null)
      setAvatarUrl(null)
      setStatus('Avatar removed.')
    } catch (e: any) {
      setError(e?.message ? String(e.message) : 'Failed to remove avatar')
    } finally {
      setAvatarBusy(false)
    }
  }

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
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.18)',
              background: avatarUrl ? `url(${avatarUrl}) center/cover no-repeat` : '#111827',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: 18,
            }}
            aria-label="Avatar"
          >
            {!avatarUrl && (displayName.trim()[0] || email?.[0] || '?').toUpperCase()}
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#f9fafb' }}>
              {displayName.trim() || 'Profile'}
            </div>
            <div style={{ color: '#cbd5e1', marginTop: 4 }}>{email ?? '—'}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <a href="/groups" style={{ color: '#e5e7eb', textDecoration: 'none' }}>
            Home
          </a>
        </div>
      </div>

      <div style={{ marginTop: 16, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, padding: 18 }}>
        <div style={{ fontWeight: 700, color: '#111827' }}>Avatar</div>
        <div style={{ color: '#6b7280', marginTop: 6 }}>A small profile photo shown to group members.</div>
        <div style={{ marginTop: 12, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 999,
              border: '1px solid #e5e7eb',
              background: avatarUrl ? `url(${avatarUrl}) center/cover no-repeat` : '#111827',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
            }}
            aria-label="Avatar preview"
          >
            {!avatarUrl && (displayName.trim()[0] || email?.[0] || '?').toUpperCase()}
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="file"
              accept="image/*"
              disabled={avatarBusy || !userId}
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (!f) return
                await uploadAvatar(f)
                e.target.value = ''
              }}
            />
            <button
              onClick={removeAvatar}
              disabled={avatarBusy || !userId}
              style={{
                height: 40,
                padding: '0 14px',
                borderRadius: 10,
                border: '1px solid #e5e7eb',
                background: '#ffffff',
                color: '#111827',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Remove
            </button>
            {avatarBusy && <span style={{ color: '#6b7280' }}>Working…</span>}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, padding: 18 }}>
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

      <div style={{ marginTop: 16, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, padding: 18 }}>
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

      <div style={{ marginTop: 16, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, padding: 18 }}>
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


