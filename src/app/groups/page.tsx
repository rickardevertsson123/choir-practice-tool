'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSupabaseBrowser } from '../../lib/supabaseBrowser'
import styles from './groups.module.css'

export default function GroupsPage() {
  const router = useRouter()
  const supabase = useMemo(() => getSupabaseBrowser(), [])
  const [email, setEmail] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'needs_verification' | 'ok'>('loading')

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

  async function logout() {
    await supabase.auth.signOut()
    router.replace('/auth')
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
          <div className={styles.card}>
            <p style={{ fontWeight: 800, color: '#111827' }}>You don’t have any groups yet.</p>
            <p className={styles.muted} style={{ marginTop: 6 }}>
              Next step: we’ll add “Create group” + membership management here.
            </p>
            <p style={{ marginTop: 12 }}>
              <a className={styles.link} href="/">
                Back to home
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}


