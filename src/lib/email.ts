type SendEmailArgs = {
  to: string[]
  subject: string
  text: string
}

export async function sendEmail(args: SendEmailArgs): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.EMAIL_FROM
  // Email is optional: if no provider env vars are set, we skip silently.
  if (!apiKey || !from) return { ok: true, skipped: true }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: args.to,
        subject: args.subject,
        text: args.text,
      }),
    })

    if (!r.ok) {
      const j = await r.json().catch(() => ({}))
      return { ok: false, error: j?.message || `Resend HTTP ${r.status}` }
    }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ? String(e.message) : 'Unknown email error' }
  }
}


