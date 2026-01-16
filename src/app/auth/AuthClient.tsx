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
  const [password2, setPassword2] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)

  const supabase = useMemo(() => getSupabaseBrowser(), [])
  const DISABLE_SIGNUP =
    String(process.env.NEXT_PUBLIC_DISABLE_SIGNUP ?? 'false').toLowerCase() === 'true'

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
    if (m === 'login') setMode('login')
    if (m === 'signup') setMode(DISABLE_SIGNUP ? 'login' : 'signup')
  }, [search])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setStatus(null)

    try {
      const redirect = search?.get('redirect')
      const joinToken = search?.get('joinToken')

      if (mode === 'signup') {
        if (DISABLE_SIGNUP) {
          setError('Sign up is disabled (closed beta).')
          setMode('login')
          return
        }
        const redirectTo =
          redirect && redirect.startsWith('/join/') ? `${window.location.origin}${redirect}` : `${window.location.origin}/groups`
        const dn = displayName.trim()
        if (!dn) {
          setError('Please enter a display name.')
          return
        }
        if (password !== password2) {
          setError('Passwords do not match.')
          return
        }
        const { error: signUpErr } = await supabase.auth.signUp({
          email,
          password,
          options: {
            // Send users back to the site after email verification.
            emailRedirectTo: redirectTo,
            data: {
              display_name: dn,
            },
          },
        })
        if (signUpErr) throw signUpErr
        setStatus('Account created. Check your email to verify, then log in.')
        setMode('login')
        setPassword('')
        setPassword2('')
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
        const metaName = (user as any)?.user_metadata?.display_name
        const { data: p } = await supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle()
        const shouldSet = !p?.display_name && typeof metaName === 'string' && metaName.trim().length > 0
        await supabase.from('profiles').upsert({
          id: user.id,
          email: user.email ?? null,
          ...(shouldSet ? { display_name: metaName.trim() } : {}),
        })
      } catch {
        // Ignore: schema might not be applied yet.
      }

      // If this login came from a join link, auto-request membership.
      if (joinToken) {
        try {
          const { data: s } = await supabase.auth.getSession()
          const token = s.session?.access_token
          if (token) {
            await fetch('/api/join', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
              body: JSON.stringify({ token: joinToken }),
            })
          }
        } catch {
          // Best-effort; user can still click Request membership on /join page.
        }
      }

      router.replace(redirect || '/groups')
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

        <div className={styles.notice}>
          <strong>Under construction:</strong> ChoirUp is in active development. Accounts, groups, and uploaded material may be changed or removed during
          updates.
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
          {!DISABLE_SIGNUP && (
            <button
              type="button"
              onClick={() => setMode('signup')}
              className={`${styles.tab} ${mode === 'signup' ? styles.tabActive : ''}`}
              aria-selected={mode === 'signup'}
            >
              Sign up
            </button>
          )}
        </div>

        {DISABLE_SIGNUP && (
          <div className={`${styles.alert} ${styles.alertError}`} style={{ marginTop: 12 }}>
            Sign up is disabled (closed beta).
          </div>
        )}

        <form onSubmit={onSubmit} className={styles.form}>
          {mode === 'signup' && !DISABLE_SIGNUP && (
            <label className={styles.fieldLabel}>
              Display name
              <input
                className={styles.input}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                type="text"
                autoComplete="name"
                required
                placeholder="Your name (e.g. Rickard)"
              />
            </label>
          )}

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
            <div className={styles.inputRow}>
              <input
                className={`${styles.input} ${styles.inputWithIcon}`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type={showPassword ? 'text' : 'password'}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                required
                placeholder="••••••••"
              />
              <button
                type="button"
                className={styles.eyeBtn}
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                </svg>
              </button>
            </div>
          </label>

          {mode === 'signup' && !DISABLE_SIGNUP && (
            <label className={styles.fieldLabel}>
              Confirm password
              <div className={styles.inputRow}>
                <input
                  className={`${styles.input} ${styles.inputWithIcon}`}
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  className={styles.eyeBtn}
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                  </svg>
                </button>
              </div>
            </label>
          )}

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


