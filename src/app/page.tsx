import styles from './home.module.css'

export default function HomePage() {
  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.hero}>
          <div className={styles.heroInner}>
            <div className={styles.brandRow}>
              <div className={styles.brandLeft}>
                <div className={styles.brand}>ChoirUp</div>
              </div>
              <div className={styles.ctaRow} style={{ marginTop: 0 }}>
                <a className={`${styles.btn} ${styles.btnPrimary}`} href="/groups">
                  My groups
                </a>
                <a className={styles.btn} href="/play">
                  Play locally
                </a>
                <a className={styles.btn} href="/auth">
                  Log in
                </a>
              </div>
            </div>

            <div className={styles.tagline}>Practice together. Sing better. Share music responsibly.</div>
            <div className={styles.lede}>
              ChoirUp is a free practice tool for singers and choirs. Practice music locally in your browser, or—if your group has the right to share
              material—create a private group and practice together in a controlled and responsible way.
            </div>
          </div>
        </div>

        <div className={styles.grid}>
          <div className={styles.card}>
            <div className={styles.cardTitle}>Private groups (not public distribution)</div>
            <div className={styles.cardBody}>
              Uploads are accessible only to group members. No public library, no public search, and no indexing. ChoirUp is a practice tool—not a music catalog.
            </div>
          </div>
          <div className={styles.card}>
            <div className={styles.cardTitle}>Local practice mode</div>
            <div className={styles.cardBody}>
              Want to practice on your own? Use local playback: no upload, no server storage, no sharing. Everything stays on your device.
            </div>
          </div>
        </div>

        <div className={styles.footerRow}>
          <a className={styles.footerLink} href="/terms">
            Terms & Responsibility
          </a>
          <a className={styles.footerLink} href="/about">
            About
          </a>
        </div>
      </div>
    </div>
  )
}


