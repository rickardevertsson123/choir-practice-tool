'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getSupabaseBrowser } from '../../lib/supabaseBrowser'
import styles from './auth.module.css'

type Mode = 'login' | 'signup'

export default function AuthClient() {
  const router = useRouter()
  const search = useSearchParams()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const supabase = useMemo(() => getSupabaseBrowser(), [])

  useEffect(() => {
    // If already logged in, go to groups.
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      if (data.session?.user) router.replace('/groups')
    })
    return () => {
      cancelled = true
    }
  }, [router, supabase])

  useEffect(() => {
    const m = search?.get('mode')
    if (m === 'signup' || m === 'login') setMode(m)
  }, [search])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setStatus(null)

    try {
      if (mode === 'signup') {
        const { error: signUpErr } = await supabase.auth.signUp({
          email,
          password,
          options: {
            // Send users back to the site after email verification.
            emailRedirectTo: `${window.location.origin}/groups`,
          },
        })
        if (signUpErr) throw signUpErr
        setStatus('Account created. Check your email to verify, then log in.')
        setMode('login')
        return
      }

      const { data, error: signInErr } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      if (signInErr) throw signInErr

      const user = data.user
      const emailVerified = Boolean(user?.email_confirmed_at)
      if (!emailVerified) {
        setStatus('Logged in, but email is not verified yet. Check your inbox and refresh.')
        return
      }

      // Ensure a profile row exists (used for admin/owner counts + later group logic).
      try {
        await supabase.from('profiles').upsert({ id: user.id, email: user.email ?? null })
      } catch {
        // Ignore: schema might not be applied yet.
      }

      router.replace('/groups')
    } catch (err: any) {
      setError(err?.message ? String(err.message) : 'Unknown error')
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.title}>{mode === 'signup' ? 'Create account' : 'Log in'}</div>
        <div className={styles.subtitle}>
          {mode === 'signup'
            ? 'Create an account and verify your email to access groups.'
            : 'Sign in to access your groups.'}
        </div>

        <div className={styles.tabs} role="tablist" aria-label="Auth mode">
          <button
            type="button"
            onClick={() => setMode('login')}
            className={`${styles.tab} ${mode === 'login' ? styles.tabActive : ''}`}
            aria-selected={mode === 'login'}
          >
            Log in
          </button>
          <button
            type="button"
            onClick={() => setMode('signup')}
            className={`${styles.tab} ${mode === 'signup' ? styles.tabActive : ''}`}
            aria-selected={mode === 'signup'}
          >
            Sign up
          </button>
        </div>

        <form onSubmit={onSubmit} className={styles.form}>
          <label className={styles.fieldLabel}>
            Email
            <input
              className={styles.input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </label>

          <label className={styles.fieldLabel}>
            Password
            <input
              className={styles.input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              placeholder="••••••••"
            />
          </label>

          <button type="submit" className={styles.primaryBtn}>
            {mode === 'signup' ? 'Create account' : 'Log in'}
          </button>
        </form>

        <div className={styles.hint}>
          {mode === 'signup'
            ? 'You will receive an email with a verification link.'
            : 'Tip: if you just signed up, verify your email first.'}
        </div>

        {status && <div className={`${styles.alert} ${styles.alertSuccess}`}>{status}</div>}
        {error && <div className={`${styles.alert} ${styles.alertError}`}>{error}</div>}

        <div className={styles.links}>
          <a className={styles.link} href="/">
            Back to home
          </a>
          <a className={styles.link} href="/groups">
            My groups
          </a>
        </div>
      </div>
    </div>
  )
}


