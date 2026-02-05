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
    <html lang="en" className="h-full">
      <body className="h-full overflow-hidden">
        <WagmiProvider>
          {children}
        </WagmiProvider>
      </body>
    </html>
  )
}
