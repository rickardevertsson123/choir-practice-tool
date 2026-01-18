import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const TERMS_MD = `# Terms & Responsibility

ChoirUp is a practice tool designed for individual singers and groups who want to rehearse music in a responsible and controlled way.

By using ChoirUp, you agree to the following principles.

## 1. Local playback (no sharing)

You may open and play music files locally in your web browser.

- Files are selected from your own device
- No files are uploaded to any server
- No copies are stored or shared
- Everything stays on your own computer

This mode is intended for private practice only.

## 2. Groups and uploaded material

If you create a group and upload music files, you act as the group administrator.

By uploading material, you confirm that your group has the necessary rights or permissions to upload, store, copy, and make the material available to the group’s members within ChoirUp.

This may include:

- material you own
- licensed or purchased scores
- public-domain works
- other material you are legally allowed to share internally

You are responsible for ensuring that these rights exist.

## 3. Private access only

- Uploaded files are accessible only to members of the group
- There is no public access, public search, or public indexing
- Files are never shared between different groups
- ChoirUp does not provide a public music library or catalog

ChoirUp is a practice tool, not a distribution service.

## 4. Responsible use

ChoirUp is intended to be used in good faith. However, ChoirUp reserves the right to take action whenever ChoirUp reasonably believes it is necessary to protect rights holders, users, or the service.

If ChoirUp becomes aware of, or reasonably suspects, that uploaded material is shared without the required rights or permissions, ChoirUp may remove the material and may restrict, disable, or suspend accounts and/or groups — with or without prior notice.

ChoirUp provides the service as-is and does not verify the legality of uploaded material.

If you believe material on ChoirUp infringes copyright or other rights, please report it to ChoirUp. When reporting, include enough information for ChoirUp to identify the material and the relevant group, and (if applicable) a link or reference to the rights holder’s claim. Reports do not need to follow any specific legal format.

## 5. Privacy and data use

- No advertising
- No tracking
- No cookies for marketing or analytics
- No analysis of uploaded music
- No analysis of users’ voices or recordings

Any microphone use or recording features operate locally in the user’s browser. Audio is not uploaded or stored by the service.

## 6. About the service

ChoirUp is a small, independent project created by someone who enjoys music and software development.

The goal is simple:

- help singers practice more effectively
- help groups share material in a controlled and responsible way
- avoid uncontrolled copying and file distribution

## 7. Questions or concerns

If you believe material on ChoirUp infringes your rights, or if you have questions about the service, please get in touch using the contact information provided on the site.
`

export default function TermsPage() {
  return (
    <div style={{ maxWidth: 980, margin: '40px auto', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#f9fafb' }}>Terms & Responsibility</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <a href="/" style={{ color: '#e5e7eb' }}>
            Home
          </a>
          <a href="/groups" style={{ color: '#e5e7eb' }}>
            My groups
          </a>
        </div>
      </div>

      <div style={{ marginTop: 16, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, padding: 18, color: '#111827' }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: (props) => <h1 style={{ margin: '6px 0 12px', lineHeight: 1.15 }} {...props} />,
            h2: (props) => <h2 style={{ margin: '18px 0 10px', lineHeight: 1.2 }} {...props} />,
            h3: (props) => <h3 style={{ margin: '18px 0 10px', lineHeight: 1.2 }} {...props} />,
            p: (props) => <p style={{ margin: '12px 0' }} {...props} />,
            ul: (props) => <ul style={{ margin: '10px 0 14px', paddingLeft: '1.25rem' }} {...props} />,
            ol: (props) => <ol style={{ margin: '10px 0 14px', paddingLeft: '1.25rem' }} {...props} />,
            li: (props) => <li style={{ margin: '6px 0' }} {...props} />,
          }}
        >
          {TERMS_MD}
        </ReactMarkdown>
      </div>
    </div>
  )
}


