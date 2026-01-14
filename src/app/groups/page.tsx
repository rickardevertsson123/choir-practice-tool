'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSupabaseBrowser } from '../../lib/supabaseBrowser'
import styles from './groups.module.css'

type MembershipRow = {
  role: 'admin' | 'member'
  status: 'active' | 'pending' | 'rejected'
  group: {
    id: string
    name: string
    created_at: string
    disabled_at: string | null
    disabled_reason: string | null
    cover_image_path: string | null
  } | null
}

export default function GroupsPage() {
  const router = useRouter()
  const supabase = useMemo(() => getSupabaseBrowser(), [])
  const [email, setEmail] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'needs_verification' | 'ok'>('loading')
  const [groups, setGroups] = useState<MembershipRow[]>([])
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({})
  const [groupName, setGroupName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    supabase.auth.getSession().then(async ({ data }) => {
      if (cancelled) return
      const user = data.session?.user
      if (!user) {
        router.replace('/auth')
        return
      }
      setEmail(user.email ?? null)
      if (!user.email_confirmed_at) {
        setStatus('needs_verification')
        return
      }

      // Ensure a profile row exists (used for admin/owner counts + later group logic).
      try {
        await supabase.from('profiles').upsert({ id: user.id, email: user.email ?? null })
      } catch {
        // Ignore: schema might not be applied yet.
      }

      setStatus('ok')
    })

    return () => {
      cancelled = true
    }
  }, [router, supabase])

  // Auto-load groups when we're logged in + verified.
  useEffect(() => {
    if (status !== 'ok') return
    refreshGroups()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  async function refreshGroups() {
    setError(null)
    const { data: sessionData } = await supabase.auth.getSession()
    const user = sessionData.session?.user
    if (!user) return

    const { data, error } = await supabase
      .from('group_memberships')
      .select('role,status,group:groups(id,name,created_at,disabled_at,disabled_reason,cover_image_path)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      setError(error.message)
      return
    }
    const rows = (data ?? []) as any as MembershipRow[]
    setGroups(rows)

    // Load signed URLs for covers (only if membership is active).
    const pairs: Array<{ groupId: string; path: string }> = []
    for (const m of rows) {
      const g = m.group
      if (!g) continue
      if (m.status !== 'active') continue
      if (!g.cover_image_path) continue
      pairs.push({ groupId: g.id, path: g.cover_image_path })
    }

    if (pairs.length === 0) {
      setCoverUrls({})
      return
    }

    const next: Record<string, string> = {}
    await Promise.all(
      pairs.map(async (p) => {
        try {
          const { data, error } = await supabase.storage.from('group-covers').createSignedUrl(p.path, 60 * 60)
          if (error) return
          if (data?.signedUrl) next[p.groupId] = data.signedUrl
        } catch {
          // ignore
        }
      })
    )
    setCoverUrls(next)
  }

  async function logout() {
    await supabase.auth.signOut()
    router.replace('/auth')
  }

  async function createGroup() {
    setError(null)
    const name = groupName.trim()
    if (!name) {
      setError('Please enter a group name.')
      return
    }

    setBusy(true)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const user = sessionData.session?.user
      if (!user) {
        router.replace('/auth')
        return
      }
      if (!user.email_confirmed_at) {
        setError('Please verify your email first.')
        return
      }

      const { data: g, error: eg } = await supabase
        .from('groups')
        .insert({ name, created_by: user.id })
        .select('id')
        .single()
      if (eg) throw eg

      const { error: em } = await supabase.from('group_memberships').insert({
        group_id: g.id,
        user_id: user.id,
        role: 'admin',
        status: 'active',
      })
      if (em) throw em

      setGroupName('')
      await refreshGroups()
    } catch (e: any) {
      setError(e?.message ? String(e.message) : 'Unknown error')
    } finally {
      setBusy(false)
    }
  }

  if (status === 'loading') return <div className={styles.page} style={{ padding: 16 }}>Loading…</div>

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>My groups</div>
            <div className={styles.subtitle}>
              Signed in as <span className={styles.muted}>{email ?? '—'}</span>
            </div>
          </div>
          <button className={styles.btn} onClick={logout}>
            Log out
          </button>
        </div>

        {status === 'needs_verification' ? (
          <div className={styles.card}>
            <div className={styles.alert}>
              Your email is not verified yet. Check your inbox and click the verification link, then refresh this page.
            </div>
          </div>
        ) : (
          <>
            <div className={styles.card}>
              <div className={styles.sectionTitle}>Create group</div>
              <div className={styles.row}>
                <input
                  className={styles.input}
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Group name (e.g. St. Mary’s Choir)"
                />
                <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={createGroup} disabled={busy}>
                  {busy ? 'Creating…' : 'Create'}
                </button>
                <button className={styles.btn} onClick={refreshGroups} disabled={busy}>
                  Refresh
                </button>
              </div>
              {error && <div className={styles.alert}>{error}</div>}
            </div>

            <div className={styles.card}>
              <div className={styles.sectionTitle}>My groups</div>
              {groups.length === 0 ? (
                <p className={styles.muted}>No groups yet.</p>
              ) : (
                <div className={styles.list}>
                  {groups.map((m) => {
                    const g = m.group
                    if (!g) return null
                    const disabled = Boolean(g.disabled_at)
                    const canOpen = m.status === 'active'
                    const cover = coverUrls[g.id]
                    return (
                      <div key={g.id} className={styles.groupItem}>
                        {cover && <div className={styles.groupCover} style={{ backgroundImage: `url(${cover})` }} />}
                        {cover && <div className={styles.groupCoverOverlay} />}
                        <div className={styles.groupContent}>
                          <div>
                            <div style={{ fontWeight: 700, color: '#111827' }}>{g.name}</div>
                            <div className={styles.muted} style={{ fontSize: 13 }}>
                              Role: {m.role} · Status: {m.status}
                            </div>
                            {disabled && (
                              <div className={styles.muted} style={{ fontSize: 13, marginTop: 4 }}>
                                Disabled: {g.disabled_reason ?? '—'}
                              </div>
                            )}
                          </div>
                          <div className={styles.row}>
                            {disabled && <span className={styles.badgeDisabled}>Disabled</span>}
                            {canOpen ? (
                              <a className={`${styles.btn} ${styles.btnPrimary}`} href={`/g/${g.id}`}>
                                Open
                              </a>
                            ) : (
                              <button className={styles.btn} disabled title="Membership is not active">
                                Open
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              <p style={{ marginTop: 12 }}>
                <a className={styles.link} href="/">
                  Back to home
                </a>
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}


