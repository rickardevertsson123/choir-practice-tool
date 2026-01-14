'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSupabaseBrowser } from '../../lib/supabaseBrowser'
import styles from './owner.module.css'

type Stats = {
  users: number
  disabledUsers: number
  groups: number
  disabledGroups: number
}

type ProfileRow = {
  id: string
  email: string | null
  display_name: string | null
  created_at: string
  disabled_at: string | null
  disabled_reason: string | null
}

type GroupRow = {
  id: string
  name: string
  created_at: string
  disabled_at: string | null
  disabled_reason: string | null
}

export default function OwnerPage() {
  const router = useRouter()
  const supabase = useMemo(() => getSupabaseBrowser(), [])
  const [token, setToken] = useState<string | null>(null)

  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [userQuery, setUserQuery] = useState('')
  const [users, setUsers] = useState<ProfileRow[]>([])

  const [groupQuery, setGroupQuery] = useState('')
  const [groups, setGroups] = useState<GroupRow[]>([])

  useEffect(() => {
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      const s = data.session
      if (!s?.user) {
        router.replace('/auth')
        return
      }
      setToken(s.access_token)
    })
    return () => {
      cancelled = true
    }
  }, [router, supabase])

  async function apiGet(path: string) {
    if (!token) throw new Error('No session')
    const r = await fetch(path, { headers: { Authorization: `Bearer ${token}` } })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j?.error || j?.hint || `HTTP ${r.status}`)
    return j
  }

  async function apiPost(path: string, body: any) {
    if (!token) throw new Error('No session')
    const r = await fetch(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
    return j
  }

  async function refresh() {
    setError(null)
    try {
      const s = await apiGet('/api/owner/stats')
      setStats(s)
    } catch (e: any) {
      setError(e?.message ? String(e.message) : 'Unknown error')
    }
  }

  async function searchUsers() {
    setError(null)
    try {
      const r = await apiGet(`/api/owner/users?q=${encodeURIComponent(userQuery)}`)
      setUsers(r.users ?? [])
    } catch (e: any) {
      setError(e?.message ? String(e.message) : 'Unknown error')
    }
  }

  async function searchGroups() {
    setError(null)
    try {
      const r = await apiGet(`/api/owner/groups?q=${encodeURIComponent(groupQuery)}`)
      setGroups(r.groups ?? [])
    } catch (e: any) {
      setError(e?.message ? String(e.message) : 'Unknown error')
    }
  }

  useEffect(() => {
    if (!token) return
    refresh()
  }, [token])

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Owner console</div>
            <div className={styles.muted}>Moderation + maintenance</div>
          </div>
          <div className={styles.row}>
            <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={refresh} disabled={!token}>
              Refresh
            </button>
            <a className={styles.btn as any} href="/groups">
              Back to My groups
            </a>
          </div>
        </div>

        {error && <div className={styles.alert}>{error}</div>}

        <div className={styles.card}>
          <div className={styles.row}>
            <div className={styles.pill}>Users: {stats?.users ?? '—'}</div>
            <div className={styles.pill}>Disabled users: {stats?.disabledUsers ?? '—'}</div>
            <div className={styles.pill}>Groups: {stats?.groups ?? '—'}</div>
            <div className={styles.pill}>Disabled groups: {stats?.disabledGroups ?? '—'}</div>
          </div>
          <div className={styles.muted} style={{ marginTop: 8 }}>
            Note: counts come from app tables (profiles/groups). Apply the SQL schema first.
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.row}>
            <div style={{ fontWeight: 700, color: '#111827' }}>Users</div>
            <input
              className={styles.input}
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
              placeholder="Search email…"
            />
            <button className={styles.btn} onClick={searchUsers} disabled={!token}>
              Search
            </button>
          </div>

          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Email</th>
                <th className={styles.th}>Status</th>
                <th className={styles.th}>Reason</th>
                <th className={styles.th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const disabled = Boolean(u.disabled_at)
                return (
                  <tr key={u.id}>
                    <td className={styles.td}>{u.email ?? u.id}</td>
                    <td className={styles.td}>
                      {disabled ? <span className={styles.badgeDisabled}>Disabled</span> : <span className={styles.badgeActive}>Active</span>}
                    </td>
                    <td className={styles.td}>{u.disabled_reason ?? ''}</td>
                    <td className={styles.td}>
                      <button
                        className={styles.btn}
                        onClick={async () => {
                          const reason = disabled ? '' : window.prompt('Disable reason (optional):', u.disabled_reason ?? '') ?? ''
                          await apiPost(`/api/owner/users/${u.id}/disable`, { disabled: !disabled, reason })
                          await searchUsers()
                          await refresh()
                        }}
                        disabled={!token}
                      >
                        {disabled ? 'Enable' : 'Disable'}
                      </button>
                    </td>
                  </tr>
                )
              })}
              {users.length === 0 && (
                <tr>
                  <td className={styles.td} colSpan={4}>
                    <span className={styles.muted}>No users loaded.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className={styles.card}>
          <div className={styles.row}>
            <div style={{ fontWeight: 700, color: '#111827' }}>Groups</div>
            <input
              className={styles.input}
              value={groupQuery}
              onChange={(e) => setGroupQuery(e.target.value)}
              placeholder="Search group name…"
            />
            <button className={styles.btn} onClick={searchGroups} disabled={!token}>
              Search
            </button>
          </div>

          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Name</th>
                <th className={styles.th}>Status</th>
                <th className={styles.th}>Reason</th>
                <th className={styles.th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const disabled = Boolean(g.disabled_at)
                return (
                  <tr key={g.id}>
                    <td className={styles.td}>{g.name}</td>
                    <td className={styles.td}>
                      {disabled ? <span className={styles.badgeDisabled}>Disabled</span> : <span className={styles.badgeActive}>Active</span>}
                    </td>
                    <td className={styles.td}>{g.disabled_reason ?? ''}</td>
                    <td className={styles.td}>
                      <button
                        className={styles.btn}
                        onClick={async () => {
                          const reason = disabled ? '' : window.prompt('Disable reason (optional):', g.disabled_reason ?? '') ?? ''
                          await apiPost(`/api/owner/groups/${g.id}/disable`, { disabled: !disabled, reason })
                          await searchGroups()
                          await refresh()
                        }}
                        disabled={!token}
                      >
                        {disabled ? 'Enable' : 'Disable'}
                      </button>
                    </td>
                  </tr>
                )
              })}
              {groups.length === 0 && (
                <tr>
                  <td className={styles.td} colSpan={4}>
                    <span className={styles.muted}>No groups loaded.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}


