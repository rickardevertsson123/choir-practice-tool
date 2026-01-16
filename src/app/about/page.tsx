import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const ABOUT_MD = `# About ChoirUp

ChoirUp is a simple, free tool for singers and choirs who want to practice together and grow musically — without losing control over their material.

If your choir, ensemble, or group has the right to use and share music files internally, ChoirUp lets you create a private group, upload your files, and invite your members.

## Responsible sharing

When you upload music files to a group, you confirm that your group has the necessary rights or permissions to store and share that material with its members.

If material is uploaded without the required rights and this comes to my attention, the content — and potentially the group — may be removed. Repeated or serious misuse may result in account suspension.

## Private groups, not public distribution

- Uploaded files are accessible only to members of the group
- There are no public libraries, no public search, and no indexing
- Files are never shared between groups
- Access is controlled by the group administrator

## Local practice mode

If you don’t have the right to share a file with others, you can still use ChoirUp to practice privately.

- no upload
- no server storage
- no sharing

Everything stays on your own device.

## Privacy

No ads. No tracking. No analysis of your music or your singing.
`

export default function AboutPage() {
  return (
    <div style={{ maxWidth: 980, margin: '40px auto', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#f9fafb' }}>About</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <a href="/" style={{ color: '#e5e7eb' }}>
            Home
          </a>
          <a href="/terms" style={{ color: '#e5e7eb' }}>
            Terms
          </a>
        </div>
      </div>

      <div style={{ marginTop: 16, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, padding: 18, color: '#111827' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{ABOUT_MD}</ReactMarkdown>
      </div>
    </div>
  )
}


