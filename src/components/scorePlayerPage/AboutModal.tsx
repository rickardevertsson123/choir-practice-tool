import { useEffect } from 'react'

export function AboutModal(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="about-modal__backdrop" role="dialog" aria-modal="true" aria-label="About ChoirUp" onClick={onClose}>
      <div className="about-modal__panel" onClick={e => e.stopPropagation()}>
        <div className="about-modal__header">
          <div className="about-modal__title">About</div>
          <button type="button" className="about-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="about-modal__content">
          <p>
            <strong>ChoirUp</strong> helps you practice choir parts in your browser.
          </p>

          <ul>
            <li>Load and play <strong>MusicXML</strong> / <strong>MXL</strong> scores.</li>
            <li>Use the <strong>voice mixer</strong> to adjust part volumes (mute/solo) while practicing.</li>
            <li>Activate the <strong>microphone</strong> and select the voice you want to practice to get pitch feedback.</li>
          </ul>

          <p>
            <strong>Tip:</strong> Using a laptop’s built-in microphone and speakers can work poorly. For best results, use an
            external microphone or a headset.
          </p>
        </div>
      </div>
    </div>
  )
}


