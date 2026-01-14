import type { ReactNode } from 'react'
import { Inter } from 'next/font/google'

import '../index.css'
import '../App.css'
import '../components/ScorePlayerPage.css'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '500', '600', '700'],
})

export default function RootLayout(props: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>{props.children}</body>
    </html>
  )
}


