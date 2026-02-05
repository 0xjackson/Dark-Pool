import type { Metadata } from 'next'
import { WagmiProvider } from '@/providers/WagmiProvider'
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
      <body>
        <WagmiProvider>
          {children}
        </WagmiProvider>
      </body>
    </html>
  )
}
