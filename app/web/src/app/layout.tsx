import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Dark Pool',
  description: 'Private OTC matching via state channels',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
