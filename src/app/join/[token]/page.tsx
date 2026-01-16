'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { getSupabaseBrowser } from '../../../lib/supabaseBrowser'
import styles from '../join.module.css'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type JoinGroupInfo = {
  id: string
  name: string
  description_md: string | null
  disabled_at: string | null
  disabled_reason: string | null
  coverUrl: string | null
}

export default function JoinPage() {
  const params = useParams()
  const token = String((params as any)?.token ?? '')
  const supabase = useMemo(() => getSupabaseBrowser(), [])

  const [status, setStatus] = useState<'loading' | 'need_login' | 'need_verify' | 'ready' | 'done' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [group, setGroup] = useState<JoinGroupInfo | null>(null)
  const [infoError, setInfoError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setInfoError(null)
    setGroup(null)

    fetch(`/api/join/info?token=${encodeURIComponent(token)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
        if (!cancelled) setGroup(j.group ?? null)
      })
      .catch((e: any) => {
        if (!cancelled) setInfoError(e?.message ? String(e.message) : 'Failed to load group')
      })

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      const user = data.session?.user
      if (!user) {
        setStatus('need_login')
        return
      }
      if (!user.email_confirmed_at) {
        setStatus('need_verify')
        return
      }
      setStatus('ready')
    })
    return () => {
      cancelled = true
    }
  }, [supabase, token])

  async function requestJoin() {
    setError(null)
    setStatus('loading')
    const { data } = await supabase.auth.getSession()
    const s = data.session
    if (!s) {
      setStatus('need_login')
      return
    }

    try {
      const r = await fetch('/api/join', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.access_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setStatus('done')
    } catch (e: any) {
      setError(e?.message ? String(e.message) : 'Unknown error')
      setStatus('error')
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.cover}>
          {group?.coverUrl && <div className={styles.coverImage} style={{ backgroundImage: `url(${group.coverUrl})` }} />}
          <div className={styles.coverOverlay} />
          <div className={styles.coverTitle}>{group?.name ?? 'Join group'}</div>
        </div>

        <div className={styles.card}>
          <div className={styles.row} style={{ justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#111827' }}>{group?.name ?? 'Join group'}</div>
              <div className={styles.muted} style={{ marginTop: 6 }}>
                {group ? 'Request access to this group.' : 'Loading group…'}
              </div>
            </div>
            <a className={styles.btn} href="/groups">
              Home
            </a>
          </div>

          {infoError && <div style={{ marginTop: 12, color: '#991b1b', fontWeight: 700 }}>{infoError}</div>}
          {group?.disabled_at && (
            <div style={{ marginTop: 12, color: '#991b1b', fontWeight: 700 }}>
              This group is disabled.{group.disabled_reason ? ` Reason: ${group.disabled_reason}` : ''}
            </div>
          )}

          {group?.description_md && group.description_md.trim().length > 0 && (
            <div style={{ marginTop: 12 }} className={styles.markdown}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{group.description_md}</ReactMarkdown>
            </div>
          )}

      {status === 'need_login' && (
        <>
          <p>You need to log in to request membership.</p>
          <p>
            <a className={`${styles.btn} ${styles.btnPrimary}`} href={`/auth?redirect=${encodeURIComponent(`/join/${token}`)}&joinToken=${encodeURIComponent(token)}`}>
              Go to login
            </a>
          </p>
        </>
      )}

      {status === 'need_verify' && (
        <>
          <p>Your email is not verified. Verify your email, then refresh this page.</p>
          <p>
            <a href="/groups">Go to My groups</a>
          </p>
        </>
      )}

      {(status === 'ready' || status === 'error') && (
        <>
          <p>This will create a pending membership request for the group invite you opened.</p>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={requestJoin}>
            Request membership
          </button>
        </>
      )}

      {status === 'done' && (
        <>
          <p>Request sent. An admin will review it.</p>
          <p>
            <a href="/groups">Back to My groups</a>
          </p>
        </>
      )}

      {error && <p style={{ color: '#ef4444', marginTop: 12 }}>{error}</p>}
        </div>
      </div>
    </div>
  )
}


