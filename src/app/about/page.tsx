import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './about.module.css'
import Image from 'next/image'

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
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.title}>
          <div className={styles.titleLogo} aria-hidden="true">
            <Image src="/logo.png" alt="" width={32} height={32} />
          </div>
          About
        </div>
        <div className={styles.nav}>
          <a href="/">Home</a>
          <a href="/terms">Terms</a>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.content}>
          <div className={styles.markdown}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{ABOUT_MD}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  )
}


