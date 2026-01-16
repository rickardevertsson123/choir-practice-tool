'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { getSupabaseBrowser } from '../../../lib/supabaseBrowser'
import styles from './group.module.css'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type Membership = {
  role: 'admin' | 'member'
  status: 'active' | 'pending' | 'rejected'
  group: {
    id: string
    name: string
    created_at: string
    disabled_at: string | null
    disabled_reason: string | null
    cover_image_path: string | null
    description_md: string | null
  } | null
}

type PendingRequest = {
  userId: string
  createdAt: string
  email: string | null
  displayName: string | null
  avatarPath: string | null
}

type MemberRow = {
  userId: string
  role: 'admin' | 'member'
  status: 'active' | 'pending'
  createdAt: string
  email: string | null
  displayName: string | null
  avatarPath: string | null
}

type GroupScoreRow = {
  id: string
  filename: string
  display_name: string | null
  expires_at: string | null
  sort_order: number | null
  storage_path: string
  created_at: string
  created_by: string
}

export default function GroupPage() {
  const router = useRouter()
  const params = useParams()
  const groupId = String((params as any)?.groupId ?? '')

  const supabase = useMemo(() => getSupabaseBrowser(), [])
  const [loading, setLoading] = useState(true)
  const [membership, setMembership] = useState<Membership | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inviteExpiresAt, setInviteExpiresAt] = useState<string>('')
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteCopied, setInviteCopied] = useState(false)
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingRequest[]>([])
  const [pendingLoading, setPendingLoading] = useState(false)
  const [pendingError, setPendingError] = useState<string | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersError, setMembersError] = useState<string | null>(null)
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>({})

  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [coverBusy, setCoverBusy] = useState(false)
  const [coverError, setCoverError] = useState<string | null>(null)
  const [showCoverEditor, setShowCoverEditor] = useState(false)
  const [descDraft, setDescDraft] = useState<string>('')
  const [descBusy, setDescBusy] = useState(false)
  const [descError, setDescError] = useState<string | null>(null)
  const [descPreview, setDescPreview] = useState(true)
  const [showAboutEditor, setShowAboutEditor] = useState(false)

  const [scores, setScores] = useState<GroupScoreRow[]>([])
  const [scoresLoading, setScoresLoading] = useState(false)
  const [scoresError, setScoresError] = useState<string | null>(null)
  const [scoreUrls, setScoreUrls] = useState<Record<string, string>>({})
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadAttest, setUploadAttest] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadDraftExpiresAt, setUploadDraftExpiresAt] = useState<string>('')
  const [uploadDraftDisplayName, setUploadDraftDisplayName] = useState<string>('')

  const [scoreEditId, setScoreEditId] = useState<string | null>(null)
  const [scoreEditDisplayName, setScoreEditDisplayName] = useState<string>('')
  const [scoreEditExpiresAt, setScoreEditExpiresAt] = useState<string>('')

  useEffect(() => {
    let cancelled = false

    async function run() {
      setLoading(true)
      setError(null)

      const { data: sessionData } = await supabase.auth.getSession()
      const user = sessionData.session?.user
      setSessionToken(sessionData.session?.access_token ?? null)
      if (!user) {
        router.replace('/auth')
        return
      }
      if (!user.email_confirmed_at) {
        router.replace('/groups')
        return
      }
      if (!groupId) {
        router.replace('/groups')
        return
      }

      const { data, error: e } = await supabase
        .from('group_memberships')
        .select('role,status,group:groups(id,name,created_at,disabled_at,disabled_reason,cover_image_path,description_md)')
        .eq('group_id', groupId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (cancelled) return

      if (e) {
        setError(e.message)
        setMembership(null)
        setLoading(false)
        return
      }

      const m = (data ?? null) as any as Membership | null
      if (!m || !m.group) {
        setError('You do not have access to this group.')
        setMembership(null)
        setLoading(false)
        return
      }

      if (m.status !== 'active') {
        setError('Your membership is not active for this group.')
        setMembership(m)
        setLoading(false)
        return
      }

      setMembership(m)
      setDescDraft(m.group?.description_md ?? '')
      setLoading(false)
    }

    run()
    return () => {
      cancelled = true
    }
  }, [groupId, router, supabase])

  useEffect(() => {
    let cancelled = false
    async function loadCover() {
      setCoverError(null)
      setCoverUrl(null)
      const path = membership?.group?.cover_image_path ?? null
      if (!path) return
      try {
        const { data, error } = await supabase.storage.from('group-covers').createSignedUrl(path, 60 * 60)
        if (error) throw error
        if (cancelled) return
        setCoverUrl(data?.signedUrl ?? null)
      } catch (e: any) {
        if (cancelled) return
        setCoverError(e?.message ? String(e.message) : 'Failed to load cover')
      }
    }
    loadCover()
    return () => {
      cancelled = true
    }
  }, [membership?.group?.cover_image_path, supabase])

  useEffect(() => {
    let cancelled = false
    async function loadScores() {
      setScoresError(null)
      setScores([])
      setScoreUrls({})
      if (!groupId) return
      if (!membership?.group) return

      setScoresLoading(true)
      try {
        const { data, error } = await supabase
          .from('group_scores')
          .select('id,filename,display_name,expires_at,sort_order,storage_path,created_at,created_by')
          .eq('group_id', groupId)
          .order('sort_order', { ascending: true, nullsFirst: false })
          .order('created_at', { ascending: true })
        if (error) throw error
        if (cancelled) return
        const rows = (data ?? []) as any as GroupScoreRow[]
        setScores(rows)

        const nextUrls: Record<string, string> = {}
        await Promise.all(
          rows.map(async (s) => {
            try {
              const { data, error } = await supabase.storage.from('group-scores').createSignedUrl(s.storage_path, 60 * 30)
              if (!error && data?.signedUrl) nextUrls[s.id] = data.signedUrl
            } catch {
              // ignore
            }
          })
        )
        if (!cancelled) setScoreUrls(nextUrls)
      } catch (e: any) {
        if (!cancelled) setScoresError(e?.message ? String(e.message) : 'Failed to load repertoire')
      } finally {
        if (!cancelled) setScoresLoading(false)
      }
    }
    loadScores()
    return () => {
      cancelled = true
    }
  }, [groupId, membership?.group, supabase])

  function sanitizeFilename(name: string) {
    return name.replace(/[^a-zA-Z0-9._-]+/g, '_')
  }

  async function normalizeScoreOrderIfNeeded() {
    if (!canAdmin) return
    if (!groupId) return
    // Only normalize if we have nulls.
    if (!scores.some((s) => s.sort_order == null)) return

    const ordered = [...scores]
    for (let i = 0; i < ordered.length; i++) {
      ordered[i] = { ...ordered[i], sort_order: i }
    }

    // Persist (best-effort).
    for (const s of ordered) {
      await supabase.from('group_scores').update({ sort_order: s.sort_order }).eq('id', s.id).eq('group_id', groupId)
    }
    setScores(ordered)
  }

  async function moveScore(scoreId: string, dir: -1 | 1) {
    if (!canAdmin) return
    if (!groupId) return
    await normalizeScoreOrderIfNeeded()

    const cur = [...scores]
    const idx = cur.findIndex((s) => s.id === scoreId)
    if (idx < 0) return
    const j = idx + dir
    if (j < 0 || j >= cur.length) return

    const a = cur[idx]
    const b = cur[j]
    const aOrder = a.sort_order ?? idx
    const bOrder = b.sort_order ?? j

    // Swap in DB first.
    const { error: e1 } = await supabase.from('group_scores').update({ sort_order: bOrder }).eq('id', a.id).eq('group_id', groupId)
    if (e1) throw e1
    const { error: e2 } = await supabase.from('group_scores').update({ sort_order: aOrder }).eq('id', b.id).eq('group_id', groupId)
    if (e2) throw e2

    const next = cur.map((s) => {
      if (s.id === a.id) return { ...s, sort_order: bOrder }
      if (s.id === b.id) return { ...s, sort_order: aOrder }
      return s
    })
    next.sort((x, y) => {
      const xo = x.sort_order ?? Number.MAX_SAFE_INTEGER
      const yo = y.sort_order ?? Number.MAX_SAFE_INTEGER
      if (xo !== yo) return xo - yo
      return new Date(x.created_at).getTime() - new Date(y.created_at).getTime()
    })
    setScores(next)
  }

  async function compressCoverToWebp(file: File): Promise<Blob> {
    const TARGET_W = 1280
    const TARGET_H = 720

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
    canvas.width = TARGET_W
    canvas.height = TARGET_H
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas not supported')

    // center-crop to 16:9
    const srcW = img.naturalWidth
    const srcH = img.naturalHeight
    const srcAspect = srcW / srcH
    const dstAspect = TARGET_W / TARGET_H

    let cropW = srcW
    let cropH = srcH
    if (srcAspect > dstAspect) {
      // too wide
      cropW = Math.round(srcH * dstAspect)
      cropH = srcH
    } else {
      // too tall
      cropW = srcW
      cropH = Math.round(srcW / dstAspect)
    }
    const sx = Math.round((srcW - cropW) / 2)
    const sy = Math.round((srcH - cropH) / 2)

    ctx.fillStyle = '#111827'
    ctx.fillRect(0, 0, TARGET_W, TARGET_H)
    ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, TARGET_W, TARGET_H)

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

  useEffect(() => {
    let cancelled = false
    async function loadPending() {
      setPendingError(null)
      setPending([])
      if (!groupId || !sessionToken) return
      if (!(membership?.status === 'active' && membership?.role === 'admin')) return
      setPendingLoading(true)
      try {
        const r = await fetch(`/api/groups/${groupId}/requests`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${sessionToken}` },
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
        if (cancelled) return
        setPending(Array.isArray(j?.pending) ? j.pending : [])
      } catch (e: any) {
        if (cancelled) return
        setPendingError(e?.message ? String(e.message) : 'Failed to load requests')
      } finally {
        if (!cancelled) setPendingLoading(false)
      }
    }
    loadPending()
    return () => {
      cancelled = true
    }
  }, [groupId, membership, sessionToken])

  async function refreshMembers() {
    setMembersError(null)
    setMembers([])
    if (!groupId || !sessionToken) return
    if (!(membership?.status === 'active')) return
    setMembersLoading(true)
    try {
      const r = await fetch(`/api/groups/${groupId}/members`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${sessionToken}` },
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setMembers(Array.isArray(j?.members) ? j.members : [])
    } catch (e: any) {
      setMembersError(e?.message ? String(e.message) : 'Failed to load members')
    } finally {
      setMembersLoading(false)
    }
  }

  useEffect(() => {
    if (!groupId || !sessionToken || !membership?.status) return
    if (membership.status !== 'active') return
    refreshMembers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, membership?.status, sessionToken])

  // NOTE: no auto-refresh. It caused scroll jumps; admins can refresh manually.

  useEffect(() => {
    let cancelled = false
    async function loadAvatarUrls() {
      const pairs: Array<{ userId: string; path: string }> = []
      for (const m of members) {
        if (m.avatarPath) pairs.push({ userId: m.userId, path: m.avatarPath })
      }
      for (const p of pending) {
        if (p.avatarPath) pairs.push({ userId: p.userId, path: p.avatarPath })
      }

      if (pairs.length === 0) {
        setAvatarUrls({})
        return
      }

      const next: Record<string, string> = {}
      await Promise.all(
        pairs.map(async (p) => {
          try {
            const { data, error } = await supabase.storage.from('user-avatars').createSignedUrl(p.path, 60 * 60)
            if (error) return
            if (data?.signedUrl) next[p.userId] = data.signedUrl
          } catch {
            // ignore
          }
        })
      )
      if (!cancelled) setAvatarUrls(next)
    }
    loadAvatarUrls()
    return () => {
      cancelled = true
    }
  }, [members, pending, supabase])

  function initialsFromLabel(label: string) {
    const s = label.trim()
    if (!s) return '?'
    const parts = s.split(/\s+/).filter(Boolean)
    const a = parts[0]?.[0] || '?'
    const b = parts.length > 1 ? parts[1][0] : ''
    return (a + b).toUpperCase()
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.container}>Loading…</div>
      </div>
    )
  }

  const g = membership?.group
  const canAdmin = membership?.status === 'active' && membership?.role === 'admin'

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.cover}>
          {coverUrl && <div className={styles.coverImage} style={{ backgroundImage: `url(${coverUrl})` }} />}
          <div className={styles.coverOverlay} />
          <div className={styles.coverTitle}>{g?.name ?? 'Group'}</div>
          {canAdmin && (
            <button
              className={`${styles.iconBtn} ${styles.coverGear}`}
              type="button"
              title="Edit cover"
              aria-label="Edit cover"
              onClick={() => setShowCoverEditor((v) => !v)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <path
                  d="M19.4 15a8.3 8.3 0 0 0 .1-6l2-1.6-2-3.4-2.4 1a8.5 8.5 0 0 0-5.2-3l-.4-2.6H9.5L9.1 2a8.5 8.5 0 0 0-5.2 3l-2.4-1-2 3.4L1.6 9a8.3 8.3 0 0 0 .1 6l-2 1.6 2 3.4 2.4-1a8.5 8.5 0 0 0 5.2 3l.4 2.6h3.9l.4-2.6a8.5 8.5 0 0 0 5.2-3l2.4 1 2-3.4-2-1.6Z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>

        {canAdmin && showCoverEditor && (
          <div className={styles.card}>
            <div className={styles.sectionTitle}>Replace cover</div>
            <div className={styles.mutedDark} style={{ marginBottom: 10 }}>
              Upload a cover image. We will center-crop to 16:9 and compress it (WebP 1280×720).
            </div>
            <div className={styles.row}>
              <input
                type="file"
                accept="image/*"
                disabled={coverBusy}
                onChange={async (e) => {
                  setCoverError(null)
                  const f = e.target.files?.[0]
                  if (!f) return
                  setCoverBusy(true)
                  try {
                    const blob = await compressCoverToWebp(f)
                    const path = `${groupId}/cover.webp`

                    const { error: upErr } = await supabase.storage
                      .from('group-covers')
                      .upload(path, blob, { upsert: true, contentType: 'image/webp' })
                    if (upErr) throw upErr

                    const { error: dbErr } = await supabase.from('groups').update({ cover_image_path: path }).eq('id', groupId)
                    if (dbErr) throw dbErr

                    const { data, error: signErr } = await supabase.storage.from('group-covers').createSignedUrl(path, 60 * 60)
                    if (signErr) throw signErr
                    setCoverUrl(data?.signedUrl ?? null)
                    setShowCoverEditor(false)
                  } catch (err: any) {
                    setCoverError(err?.message ? String(err.message) : 'Failed to upload cover')
                  } finally {
                    setCoverBusy(false)
                    e.target.value = ''
                  }
                }}
              />
              {coverBusy && <span className={styles.mutedDark}>Uploading…</span>}
              <button className={styles.btn} type="button" onClick={() => setShowCoverEditor(false)} disabled={coverBusy}>
                Cancel
              </button>
            </div>
            {coverError && <div style={{ marginTop: 10, color: '#991b1b', fontWeight: 800 }}>{coverError}</div>}
          </div>
        )}

        <div className={styles.header}>
          <div>
            <div className={styles.title}>{g?.name ?? 'Group'}</div>
            <div className={styles.muted} style={{ marginTop: 6 }}>
              Role: {membership?.role ?? '—'}
            </div>
          </div>
          <div className={styles.row}>
            <a className={styles.iconBtn} href="/groups" title="Back to My groups" aria-label="Back to My groups">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M9 14 4 9l5-5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M20 20v-5a6 6 0 0 0-6-6H4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
            <a className={styles.iconBtn} href="/groups" title="Home" aria-label="Home">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M3 10.5 12 3l9 7.5V20a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 20v-9.5Z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
                <path d="M9.5 21.8V14h5v7.8" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              </svg>
            </a>
            <a className={styles.iconBtn} href="/profile" title="Profile" aria-label="Profile">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M20 21a8 8 0 1 0-16 0"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <path
                  d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
            </a>
          </div>
        </div>

        {g?.disabled_at && (
          <div className={styles.bannerDisabled}>
            This group is disabled.
            {g.disabled_reason ? ` Reason: ${g.disabled_reason}` : ''}
          </div>
        )}

        {error && (
          <div className={styles.card}>
            <div className={styles.sectionTitle}>Access</div>
            <div style={{ color: '#991b1b', fontWeight: 800 }}>{error}</div>
          </div>
        )}

        {!error && (
          <>
            {coverError && (
              <div className={styles.card}>
                <div className={styles.sectionTitle}>Cover</div>
                <div style={{ color: '#991b1b', fontWeight: 800 }}>{coverError}</div>
              </div>
            )}

            <div className={styles.card}>
              <div className={styles.cardHeaderRow}>
                <div className={styles.sectionTitle} style={{ marginBottom: 0 }}>
                  About
                </div>
                {canAdmin && (
                  <button
                    className={`${styles.iconBtn} ${styles.iconBtnDark}`}
                    type="button"
                    title="Edit description"
                    aria-label="Edit description"
                    onClick={() => setShowAboutEditor((v) => !v)}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                      <path
                        d="M19.4 15a8.3 8.3 0 0 0 .1-6l2-1.6-2-3.4-2.4 1a8.5 8.5 0 0 0-5.2-3l-.4-2.6H9.5L9.1 2a8.5 8.5 0 0 0-5.2 3l-2.4-1-2 3.4L1.6 9a8.3 8.3 0 0 0 .1 6l-2 1.6 2 3.4 2.4-1a8.5 8.5 0 0 0 5.2 3l.4 2.6h3.9l.4-2.6a8.5 8.5 0 0 0 5.2-3l2.4 1 2-3.4-2-1.6Z"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
              </div>

              {(g?.description_md ?? '').trim().length === 0 ? (
                <div className={styles.mutedDark} style={{ marginTop: 8 }}>
                  No description yet.
                </div>
              ) : (
                <div className={styles.markdown} style={{ marginTop: 8 }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{g?.description_md ?? ''}</ReactMarkdown>
                </div>
              )}

              {canAdmin && showAboutEditor && (
                <div style={{ marginTop: 14 }}>
                  <div className={styles.row} style={{ justifyContent: 'space-between' }}>
                    <div className={styles.mutedDark} style={{ fontSize: 13 }}>
                      Markdown supported.
                    </div>
                    <button className={styles.btn} type="button" onClick={() => setDescPreview((v) => !v)}>
                      {descPreview ? 'Hide preview' : 'Show preview'}
                    </button>
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <textarea
                      className={styles.textarea}
                      value={descDraft}
                      onChange={(e) => setDescDraft(e.target.value)}
                      placeholder="Write a short description of the choir/group…"
                    />
                  </div>

                  <div className={styles.row} style={{ marginTop: 10 }}>
                    <button
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      disabled={descBusy}
                      onClick={async () => {
                        setDescError(null)
                        setDescBusy(true)
                        try {
                          const { error: e } = await supabase.from('groups').update({ description_md: descDraft }).eq('id', groupId)
                          if (e) throw e
                          setMembership((cur) =>
                            cur && cur.group ? ({ ...cur, group: { ...cur.group, description_md: descDraft } } as any) : cur
                          )
                          setShowAboutEditor(false)
                        } catch (err: any) {
                          setDescError(err?.message ? String(err.message) : 'Failed to save')
                        } finally {
                          setDescBusy(false)
                        }
                      }}
                    >
                      {descBusy ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      className={styles.btn}
                      type="button"
                      onClick={() => {
                        setDescDraft(membership?.group?.description_md ?? '')
                        setDescError(null)
                        setShowAboutEditor(false)
                      }}
                      disabled={descBusy}
                    >
                      Cancel
                    </button>
                    {descError && <span style={{ color: '#991b1b', fontWeight: 800 }}>{descError}</span>}
                  </div>

                  {descPreview && (
                    <div style={{ marginTop: 12 }}>
                      <div className={styles.mutedDark} style={{ fontSize: 13, marginBottom: 6 }}>
                        Preview
                      </div>
                      <div
                        className={styles.markdown}
                        style={{ padding: 12, border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff' }}
                      >
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{descDraft || '_No text_'}</ReactMarkdown>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {canAdmin && (
              <div className={styles.card}>
                <div className={styles.sectionTitle}>Pending requests</div>
                {pendingLoading && <div className={styles.mutedDark}>Loading…</div>}
                {pendingError && <div style={{ color: '#991b1b', fontWeight: 800 }}>{pendingError}</div>}
                {!pendingLoading && !pendingError && pending.length === 0 && (
                  <div className={styles.mutedDark}>No pending requests.</div>
                )}
                {!pendingLoading && !pendingError && pending.length > 0 && (
                  <div style={{ display: 'grid', gap: 10 }}>
                    {pending.map((p) => (
                      <div
                        key={p.userId}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 10,
                          padding: 12,
                          borderRadius: 12,
                          border: '1px solid #e5e7eb',
                          background: '#fafafa',
                          flexWrap: 'wrap',
                        }}
                      >
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                          <div
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: 999,
                              border: '1px solid #e5e7eb',
                              background: avatarUrls[p.userId] ? `url(${avatarUrls[p.userId]}) center/cover no-repeat` : '#111827',
                              color: '#fff',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontWeight: 700,
                              fontSize: 12,
                            }}
                            aria-label="Avatar"
                          >
                            {!avatarUrls[p.userId] && initialsFromLabel(p.displayName || p.email || p.userId)}
                          </div>
                          <div>
                          <div style={{ fontWeight: 700, color: '#111827' }}>
                            {p.displayName || p.email || p.userId}
                          </div>
                          <div className={styles.mutedDark} style={{ fontSize: 13 }}>
                            Requested: {new Date(p.createdAt).toLocaleString()}
                          </div>
                          </div>
                        </div>
                        <div className={styles.row}>
                          <button
                            className={`${styles.btn} ${styles.btnPrimary}`}
                            disabled={!sessionToken}
                            onClick={async () => {
                              try {
                                const r = await fetch(`/api/groups/${groupId}/requests/${p.userId}/approve`, {
                                  method: 'POST',
                                  headers: { Authorization: `Bearer ${sessionToken}` },
                                })
                                const j = await r.json().catch(() => ({}))
                                if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
                                setPending((cur) => cur.filter((x) => x.userId !== p.userId))
                                await refreshMembers()
                              } catch (e: any) {
                                setPendingError(e?.message ? String(e.message) : 'Failed to approve')
                              }
                            }}
                          >
                            Approve
                          </button>
                          <button
                            className={styles.btn}
                            disabled={!sessionToken}
                            onClick={async () => {
                              try {
                                const r = await fetch(`/api/groups/${groupId}/requests/${p.userId}/deny`, {
                                  method: 'POST',
                                  headers: { Authorization: `Bearer ${sessionToken}` },
                                })
                                const j = await r.json().catch(() => ({}))
                                if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
                                setPending((cur) => cur.filter((x) => x.userId !== p.userId))
                              } catch (e: any) {
                                setPendingError(e?.message ? String(e.message) : 'Failed to deny')
                              }
                            }}
                          >
                            Deny
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ marginTop: 14, borderTop: '1px solid #e5e7eb', paddingTop: 14 }}>
                  <div style={{ fontWeight: 700, color: '#111827' }}>Invite link</div>
                  <div className={styles.mutedDark} style={{ marginTop: 6, marginBottom: 10 }}>
                    Generate a time-limited join link. Generating a new link revokes the previous one.
                  </div>
                  <div className={styles.row}>
                    <label className={styles.mutedDark} style={{ fontSize: 13 }}>
                      Expires at
                      <input
                        type="date"
                        value={inviteExpiresAt}
                        onChange={(e) => setInviteExpiresAt(e.target.value)}
                        style={{ marginLeft: 10, height: 40, borderRadius: 10, border: '1px solid #d1d5db', padding: '0 12px' }}
                      />
                    </label>
                    <button
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      disabled={inviteBusy || !inviteExpiresAt || !sessionToken}
                      onClick={async () => {
                        setInviteError(null)
                        setInviteUrl(null)
                        if (!inviteExpiresAt) return
                        setInviteBusy(true)
                        try {
                          // Interpret date as end-of-day local time.
                          const expires = new Date(`${inviteExpiresAt}T23:59:59`)
                          const r = await fetch(`/api/groups/${groupId}/invite`, {
                            method: 'POST',
                            headers: {
                              Authorization: `Bearer ${sessionToken}`,
                              'content-type': 'application/json',
                            },
                            body: JSON.stringify({ expiresAt: expires.toISOString() }),
                          })
                          const j = await r.json().catch(() => ({}))
                          if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
                          setInviteUrl(j.joinUrl)
                        } catch (e: any) {
                          setInviteError(e?.message ? String(e.message) : 'Unknown error')
                        } finally {
                          setInviteBusy(false)
                        }
                      }}
                    >
                      {inviteBusy ? 'Generating…' : 'Generate link'}
                    </button>
                  </div>
                  {inviteUrl && (
                    <div style={{ marginTop: 10 }}>
                      <div className={styles.mutedDark} style={{ fontSize: 13, marginBottom: 6 }}>
                        Join link
                      </div>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        <code
                          style={{
                            padding: '8px 10px',
                            background: '#f3f4f6',
                            border: '1px solid #e5e7eb',
                            borderRadius: 10,
                            color: '#374151',
                          }}
                        >
                          {inviteUrl}
                        </code>
                        <button
                          className={styles.btn}
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(inviteUrl)
                              setInviteCopied(true)
                              window.setTimeout(() => setInviteCopied(false), 1200)
                            } catch {}
                          }}
                        >
                          {inviteCopied ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  )}
                  {inviteError && <div style={{ marginTop: 10, color: '#991b1b', fontWeight: 800 }}>{inviteError}</div>}
                </div>
              </div>
            )}

            {membership?.status === 'active' && (
              <div className={styles.card}>
                <div className={styles.row} style={{ justifyContent: 'space-between' }}>
                  <div className={styles.sectionTitle} style={{ marginBottom: 0 }}>
                    Members
                  </div>
                  <button className={styles.btn} onClick={refreshMembers} disabled={!sessionToken || membersLoading}>
                    Refresh
                  </button>
                </div>
                {membersLoading && <div className={styles.mutedDark}>Loading…</div>}
                {membersError && <div style={{ color: '#991b1b', fontWeight: 800 }}>{membersError}</div>}
                {!membersLoading && !membersError && members.length === 0 && (
                  <div className={styles.mutedDark}>No members found.</div>
                )}
                {!membersLoading && !membersError && members.length > 0 && (
                  <div style={{ display: 'grid', gap: 10 }}>
                    {members.map((m) => {
                      const label = m.displayName || m.email || m.userId
                      const badge =
                        m.status === 'pending'
                          ? { text: 'Pending', bg: 'rgba(234, 179, 8, 0.14)', border: 'rgba(234, 179, 8, 0.45)', color: '#92400e' }
                          : { text: m.role === 'admin' ? 'Admin' : 'Member', bg: '#eef2ff', border: '#c7d2fe', color: '#3730a3' }
                      return (
                        <div
                          key={m.userId}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 10,
                            padding: 12,
                            borderRadius: 12,
                            border: '1px solid #e5e7eb',
                            background: '#ffffff',
                            flexWrap: 'wrap',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <div
                              style={{
                                width: 32,
                                height: 32,
                                borderRadius: 999,
                                border: '1px solid #e5e7eb',
                                background: avatarUrls[m.userId] ? `url(${avatarUrls[m.userId]}) center/cover no-repeat` : '#111827',
                                color: '#fff',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontWeight: 700,
                                fontSize: 12,
                              }}
                              aria-label="Avatar"
                            >
                              {!avatarUrls[m.userId] && initialsFromLabel(label)}
                            </div>
                            <div style={{ fontWeight: 700, color: '#111827' }}>{label}</div>
                            <span
                              style={{
                                fontSize: 12,
                                padding: '4px 10px',
                                borderRadius: 999,
                                background: badge.bg,
                                border: `1px solid ${badge.border}`,
                                color: badge.color,
                                fontWeight: 700,
                              }}
                            >
                              {badge.text}
                            </span>
                          </div>
                          <div className={styles.row}>
                            {m.status === 'pending' && (
                              <>
                                <button
                                  className={`${styles.btn} ${styles.btnPrimary}`}
                                  disabled={!sessionToken}
                                  onClick={async () => {
                                    setMembersError(null)
                                    try {
                                      const r = await fetch(`/api/groups/${groupId}/requests/${m.userId}/approve`, {
                                        method: 'POST',
                                        headers: { Authorization: `Bearer ${sessionToken}` },
                                      })
                                      const j = await r.json().catch(() => ({}))
                                      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
                                      setMembers((cur) =>
                                        cur.map((x) => (x.userId === m.userId ? { ...x, status: 'active' } : x))
                                      )
                                      setPending((cur) => cur.filter((x) => x.userId !== m.userId))
                                      await refreshMembers()
                                    } catch (e: any) {
                                      setMembersError(e?.message ? String(e.message) : 'Failed to approve')
                                    }
                                  }}
                                >
                                  Approve
                                </button>
                                <button
                                  className={styles.btn}
                                  disabled={!sessionToken}
                                  onClick={async () => {
                                    setMembersError(null)
                                    try {
                                      const r = await fetch(`/api/groups/${groupId}/requests/${m.userId}/deny`, {
                                        method: 'POST',
                                        headers: { Authorization: `Bearer ${sessionToken}` },
                                      })
                                      const j = await r.json().catch(() => ({}))
                                      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
                                      setMembers((cur) => cur.filter((x) => x.userId !== m.userId))
                                      setPending((cur) => cur.filter((x) => x.userId !== m.userId))
                                    } catch (e: any) {
                                      setMembersError(e?.message ? String(e.message) : 'Failed to deny')
                                    }
                                  }}
                                >
                                  Deny
                                </button>
                              </>
                            )}

                            {canAdmin && (m.status === 'pending' || m.role === 'member') && (
                              <button
                                className={`${styles.iconBtn} ${styles.iconBtnDark}`}
                                style={{ width: 36, height: 36 }}
                                disabled={!sessionToken}
                                onClick={async () => {
                                  if (!confirm(`Remove ${label} from group?`)) return
                                  setMembersError(null)
                                  try {
                                    const r = await fetch(`/api/groups/${groupId}/members/${m.userId}/remove`, {
                                      method: 'POST',
                                      headers: { Authorization: `Bearer ${sessionToken}` },
                                    })
                                    const j = await r.json().catch(() => ({}))
                                    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
                                    setMembers((cur) => cur.filter((x) => x.userId !== m.userId))
                                    setPending((cur) => cur.filter((x) => x.userId !== m.userId))
                                  } catch (e: any) {
                                    setMembersError(e?.message ? String(e.message) : 'Failed to remove')
                                  }
                                }}
                                title="Remove"
                                aria-label="Remove"
                              >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                  <path d="M4 7h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                  <path d="M10 11v7M14 11v7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                  <path d="M9 7l1-2h4l1 2" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                                  <path d="M6 7l1 14h10l1-14" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            <div className={styles.card}>
              <div className={styles.sectionTitle}>Repertoire</div>

              {scoresLoading && <div className={styles.mutedDark}>Loading…</div>}
              {scoresError && <div style={{ color: '#991b1b', fontWeight: 700 }}>{scoresError}</div>}

              {!scoresLoading && !scoresError && scores.length === 0 && (
                <div className={styles.mutedDark}>No scores uploaded yet.</div>
              )}

              {!scoresLoading && !scoresError && scores.length > 0 && (
                <div style={{ display: 'grid', gap: 10 }}>
                  {scores.map((s) => {
                    const url = scoreUrls[s.id]
                    const title = (s.display_name || s.filename).trim()
                    const expiresAt = s.expires_at ? new Date(s.expires_at) : null
                    const expired = expiresAt ? Date.now() > expiresAt.getTime() : false
                    const idx = scores.findIndex((x) => x.id === s.id)
                    return (
                      <div key={s.id} style={{ display: 'grid', gap: 8 }}>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 10,
                            padding: 12,
                            borderRadius: 12,
                            border: '1px solid #e5e7eb',
                            background: '#ffffff',
                            flexWrap: 'wrap',
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 700, color: '#111827' }}>{title}</div>
                            <div className={styles.mutedDark} style={{ fontSize: 13 }}>
                              Uploaded: {new Date(s.created_at).toLocaleString()}
                            </div>
                            {expiresAt && (
                              <div className={styles.mutedDark} style={{ fontSize: 13, marginTop: 4 }}>
                                Expires: {expiresAt.toLocaleDateString()} {expired ? ' (expired)' : ''}
                              </div>
                            )}
                          </div>
                          <div className={styles.row}>
                            {url && !expired ? (
                              <a
                                className={`${styles.iconBtn} ${styles.iconBtnDark}`}
                                style={{ width: 36, height: 36 }}
                                href={`/play?scoreUrl=${encodeURIComponent(url)}`}
                                title="Play"
                                aria-label="Play"
                              >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                  <path d="M9 7v10l8-5-8-5Z" fill="currentColor" />
                                </svg>
                              </a>
                            ) : (
                              <button
                                className={`${styles.iconBtn} ${styles.iconBtnDark}`}
                                style={{ width: 36, height: 36, opacity: 0.5, cursor: 'not-allowed' }}
                                disabled
                                title={expired ? 'Expired' : 'No signed URL yet'}
                                aria-label="Play (disabled)"
                                type="button"
                              >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                  <path d="M9 7v10l8-5-8-5Z" fill="currentColor" />
                                </svg>
                              </button>
                            )}

                            {canAdmin && (
                              <button
                                className={`${styles.iconBtn} ${styles.iconBtnDark}`}
                                style={{ width: 36, height: 36 }}
                                type="button"
                                title="Settings"
                                aria-label="Settings"
                                onClick={() => {
                                  if (scoreEditId === s.id) {
                                    setScoreEditId(null)
                                    return
                                  }
                                  setScoreEditId(s.id)
                                  setScoreEditDisplayName(s.display_name ?? '')
                                  setScoreEditExpiresAt(s.expires_at ? String(s.expires_at).slice(0, 10) : '')
                                }}
                              >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                  <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" strokeWidth="2" />
                                  <path
                                    d="M19.4 15a8.3 8.3 0 0 0 .1-6l2-1.6-2-3.4-2.4 1a8.5 8.5 0 0 0-5.2-3l-.4-2.6H9.5L9.1 2a8.5 8.5 0 0 0-5.2 3l-2.4-1-2 3.4L1.6 9a8.3 8.3 0 0 0 .1 6l-2 1.6 2 3.4 2.4-1a8.5 8.5 0 0 0 5.2 3l.4 2.6h3.9l.4-2.6a8.5 8.5 0 0 0 5.2-3l2.4 1 2-3.4-2-1.6Z"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              </button>
                            )}

                            {canAdmin && (
                              <button
                                className={`${styles.iconBtn} ${styles.iconBtnDark}`}
                                style={{ width: 36, height: 36 }}
                                type="button"
                                title="Delete"
                                aria-label="Delete"
                                onClick={async () => {
                                  if (!confirm(`Delete "${title}"? This will remove it for all group members.`)) return
                                  setScoresError(null)
                                  try {
                                    const { error: dbErr } = await supabase.from('group_scores').delete().eq('id', s.id).eq('group_id', groupId)
                                    if (dbErr) throw dbErr

                                    const { error: rmErr } = await supabase.storage.from('group-scores').remove([s.storage_path])
                                    // If file is already gone, we still consider it ok.
                                    if (rmErr) console.warn('[group-scores] remove failed', rmErr)

                                    setScores((cur) => cur.filter((x) => x.id !== s.id))
                                    setScoreUrls((cur) => {
                                      const next = { ...cur }
                                      delete next[s.id]
                                      return next
                                    })
                                    if (scoreEditId === s.id) setScoreEditId(null)
                                  } catch (e: any) {
                                    setScoresError(e?.message ? String(e.message) : 'Failed to delete')
                                  }
                                }}
                              >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                  <path d="M4 7h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                  <path d="M10 11v7M14 11v7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                  <path d="M9 7l1-2h4l1 2" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                                  <path d="M6 7l1 14h10l1-14" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                                </svg>
                              </button>
                            )}

                            {canAdmin && (
                              <div className={styles.reorderCtl} title="Reorder">
                                <button
                                  className={styles.reorderCtlBtn}
                                  type="button"
                                  aria-label="Move up"
                                  disabled={idx <= 0}
                                  onClick={async () => {
                                    try {
                                      setScoresError(null)
                                      await moveScore(s.id, -1)
                                    } catch (e: any) {
                                      setScoresError(e?.message ? String(e.message) : 'Failed to reorder')
                                    }
                                  }}
                                >
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <path d="M12 7l-6 6h12l-6-6Z" fill="currentColor" />
                                  </svg>
                                </button>
                                <div className={styles.reorderCtlDivider} />
                                <button
                                  className={styles.reorderCtlBtn}
                                  type="button"
                                  aria-label="Move down"
                                  disabled={idx < 0 || idx >= scores.length - 1}
                                  onClick={async () => {
                                    try {
                                      setScoresError(null)
                                      await moveScore(s.id, 1)
                                    } catch (e: any) {
                                      setScoresError(e?.message ? String(e.message) : 'Failed to reorder')
                                    }
                                  }}
                                >
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <path d="M12 17l6-6H6l6 6Z" fill="currentColor" />
                                  </svg>
                                </button>
                              </div>
                            )}
                          </div>
                        </div>

                        {canAdmin && scoreEditId === s.id && (
                          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, background: '#fafafa' }}>
                            <div className={styles.row} style={{ marginBottom: 10 }}>
                              <input
                                type="text"
                                value={scoreEditDisplayName}
                                onChange={(e) => setScoreEditDisplayName(e.target.value)}
                                placeholder="Display name (optional)"
                                style={{ height: 40, borderRadius: 10, border: '1px solid #d1d5db', padding: '0 12px', minWidth: 260 }}
                              />
                              <label className={styles.mutedDark} style={{ fontSize: 13 }}>
                                Expires
                                <input
                                  type="date"
                                  value={scoreEditExpiresAt}
                                  onChange={(e) => setScoreEditExpiresAt(e.target.value)}
                                  style={{ marginLeft: 10, height: 40, borderRadius: 10, border: '1px solid #d1d5db', padding: '0 12px' }}
                                />
                              </label>
                            </div>
                            <div className={styles.row}>
                              <button
                                className={`${styles.btn} ${styles.btnPrimary}`}
                                type="button"
                                onClick={async () => {
                                  setScoresError(null)
                                  try {
                                    const nextDisplay = scoreEditDisplayName.trim() ? scoreEditDisplayName.trim() : null
                                    const nextExpires = scoreEditExpiresAt ? new Date(`${scoreEditExpiresAt}T23:59:59`).toISOString() : null

                                    const { error: upErr } = await supabase
                                      .from('group_scores')
                                      .update({ display_name: nextDisplay, expires_at: nextExpires })
                                      .eq('id', s.id)
                                      .eq('group_id', groupId)
                                    if (upErr) throw upErr

                                    setScores((cur) =>
                                      cur.map((x) => (x.id === s.id ? { ...x, display_name: nextDisplay, expires_at: nextExpires } : x))
                                    )
                                    setScoreEditId(null)
                                  } catch (e: any) {
                                    setScoresError(e?.message ? String(e.message) : 'Failed to save settings')
                                  }
                                }}
                              >
                                Save
                              </button>
                              <button
                                className={styles.btn}
                                type="button"
                                onClick={() => {
                                  setScoreEditId(null)
                                  setScoreEditDisplayName('')
                                  setScoreEditExpiresAt('')
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                            <div className={styles.mutedDark} style={{ fontSize: 13, marginTop: 8 }}>
                              Changes are saved for the whole group.
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {canAdmin && (
                <div style={{ marginTop: 14 }}>
                  <div className={styles.mutedDark} style={{ fontSize: 13, marginBottom: 8 }}>
                    Upload MXL / MusicXML (admins only)
                  </div>
                  <label className={styles.mutedDark} style={{ display: 'block', fontSize: 13, lineHeight: 1.35, marginBottom: 10 }}>
                    <input
                      type="checkbox"
                      checked={uploadAttest}
                      onChange={(e) => setUploadAttest(e.target.checked)}
                      style={{ marginRight: 8 }}
                    />
                    I certify that the group has the necessary rights or permissions to upload, store, copy, and make this material available to the group's members within the service. If we violate these rules, we may be removed as a user.
                  </label>
                  <div className={styles.row}>
                    <input
                      type="file"
                      accept=".mxl,.xml,.musicxml,application/vnd.recordare.musicxml+xml,application/xml,text/xml"
                      disabled={uploadBusy || !uploadAttest}
                      onChange={(e) => {
                        setUploadError(null)
                        const f = e.target.files?.[0] ?? null
                        setUploadFile(f)
                        if (f) {
                          setUploadDraftDisplayName('')
                          setUploadDraftExpiresAt('')
                        }
                        e.target.value = ''
                      }}
                    />
                    {uploadBusy && <span className={styles.mutedDark}>Uploading…</span>}
                    {!uploadBusy && !uploadAttest && <span className={styles.mutedDark}>Confirm rights to enable upload.</span>}
                  </div>

                  {uploadFile && (
                    <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, background: '#fafafa' }}>
                      <div style={{ fontWeight: 700, color: '#111827' }}>Upload details</div>
                      <div className={styles.mutedDark} style={{ fontSize: 13, marginTop: 6 }}>
                        File: {uploadFile.name}
                      </div>

                      <div className={styles.row} style={{ marginTop: 10 }}>
                        <input
                          type="text"
                          value={uploadDraftDisplayName}
                          onChange={(e) => setUploadDraftDisplayName(e.target.value)}
                          placeholder="Display name (optional)"
                          style={{ height: 40, borderRadius: 10, border: '1px solid #d1d5db', padding: '0 12px', minWidth: 260 }}
                        />
                        <label className={styles.mutedDark} style={{ fontSize: 13 }}>
                          Expires
                          <input
                            type="date"
                            value={uploadDraftExpiresAt}
                            onChange={(e) => setUploadDraftExpiresAt(e.target.value)}
                            style={{ marginLeft: 10, height: 40, borderRadius: 10, border: '1px solid #d1d5db', padding: '0 12px' }}
                          />
                        </label>
                      </div>

                      <div className={styles.row} style={{ marginTop: 10 }}>
                        <button
                          className={`${styles.btn} ${styles.btnPrimary}`}
                          type="button"
                          disabled={uploadBusy}
                          onClick={async () => {
                            setUploadError(null)
                            const f = uploadFile
                            if (!f) return
                            if (!uploadDraftExpiresAt) {
                              setUploadError('Please set an expiry date.')
                              return
                            }
                            if (!uploadAttest) {
                              setUploadError('Please confirm the rights/permissions checkbox first.')
                              return
                            }

                            setUploadBusy(true)
                            try {
                              const safe = sanitizeFilename(f.name || 'score.mxl')
                              const nextDisplay = uploadDraftDisplayName.trim() ? uploadDraftDisplayName.trim() : null
                              const ext = safe.toLowerCase().endsWith('.mxl')
                                ? 'mxl'
                                : safe.toLowerCase().endsWith('.musicxml')
                                  ? 'musicxml'
                                  : 'xml'
                              const id = crypto.randomUUID()
                              const path = `${groupId}/${id}.${ext}`

                              const { error: upErr } = await supabase.storage
                                .from('group-scores')
                                .upload(path, f, { upsert: false, contentType: f.type || undefined })
                              if (upErr) throw upErr

                              const { data: sessionData } = await supabase.auth.getSession()
                              const userId = sessionData.session?.user?.id
                              if (!userId) throw new Error('Not logged in')

                              // Append at end of current ordering.
                              let nextOrder = scores.reduce((mx, s) => {
                                const v = typeof s.sort_order === 'number' ? s.sort_order : -1
                                return Math.max(mx, v)
                              }, -1) + 1
                              if (!Number.isFinite(nextOrder)) nextOrder = 0

                              const expiresIso = new Date(`${uploadDraftExpiresAt}T23:59:59`).toISOString()
                              const { error: dbErr } = await supabase.from('group_scores').insert({
                                group_id: groupId,
                                storage_path: path,
                                filename: safe,
                                display_name: nextDisplay,
                                expires_at: expiresIso,
                                sort_order: nextOrder,
                                content_type: f.type || null,
                                created_by: userId,
                              })
                              if (dbErr) throw dbErr

                              // Refresh list
                              const { data, error } = await supabase
                                .from('group_scores')
                                .select('id,filename,display_name,expires_at,sort_order,storage_path,created_at,created_by')
                                .eq('group_id', groupId)
                                .order('sort_order', { ascending: true, nullsFirst: false })
                                .order('created_at', { ascending: true })
                              if (error) throw error
                              const rows = (data ?? []) as any as GroupScoreRow[]
                              setScores(rows)

                              const nextUrls: Record<string, string> = {}
                              await Promise.all(
                                rows.map(async (s) => {
                                  try {
                                    const { data, error } = await supabase.storage.from('group-scores').createSignedUrl(s.storage_path, 60 * 30)
                                    if (!error && data?.signedUrl) nextUrls[s.id] = data.signedUrl
                                  } catch {}
                                })
                              )
                              setScoreUrls(nextUrls)

                              setUploadFile(null)
                              setUploadDraftDisplayName('')
                              setUploadDraftExpiresAt('')
                            } catch (err: any) {
                              setUploadError(err?.message ? String(err.message) : 'Upload failed')
                            } finally {
                              setUploadBusy(false)
                            }
                          }}
                        >
                          Upload
                        </button>
                        <button
                          className={styles.btn}
                          type="button"
                          disabled={uploadBusy}
                          onClick={() => {
                            setUploadFile(null)
                            setUploadDraftDisplayName('')
                            setUploadDraftExpiresAt('')
                            setUploadError(null)
                          }}
                        >
                          Cancel
                        </button>
                        {!uploadBusy && !uploadDraftExpiresAt && <span className={styles.mutedDark}>Expiry date is required.</span>}
                      </div>

                      {uploadError && <div style={{ marginTop: 10, color: '#991b1b', fontWeight: 700 }}>{uploadError}</div>}
                    </div>
                  )}
                </div>
              )}
            </div>

            {membership?.status === 'active' && (
              <div className={styles.card}>
                <div className={styles.sectionTitle}>Danger zone</div>
                <div className={styles.mutedDark} style={{ marginBottom: 10 }}>
                  Leave the group. You can request access again via an invite link.
                </div>
                <button
                  className={styles.btn}
                  style={{
                    borderColor: 'rgba(239, 68, 68, 0.35)',
                    background: 'rgba(239, 68, 68, 0.10)',
                    color: '#991b1b',
                  }}
                  onClick={async () => {
                    if (!sessionToken) return
                    const ok = confirm('Leave this group? (Admins can only leave if another admin remains, or if the group is empty.)')
                    if (!ok) return
                    try {
                      const r = await fetch(`/api/groups/${groupId}/leave`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${sessionToken}` },
                      })
                      const j = await r.json().catch(() => ({}))
                      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
                      router.replace('/groups')
                    } catch (e: any) {
                      alert(e?.message ? String(e.message) : 'Failed to leave group')
                    }
                  }}
                  disabled={!sessionToken}
                  title="Leave group"
                >
                  Leave group
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}


