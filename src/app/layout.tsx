import type { ReactNode } from 'react'

import '../index.css'
import '../App.css'
import '../components/ScorePlayerPage.css'

export default function RootLayout(props: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{props.children}</body>
    </html>
  )
}


