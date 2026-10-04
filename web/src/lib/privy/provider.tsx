/**
 * Privy provider wired to wagmi on Monad testnet.
 * Isolated module — UI agents should wrap the app with <PrivyAppProvider> only.
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { PrivyProvider } from '@privy-io/react-auth'
import { WagmiProvider, createConfig } from '@privy-io/wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, defineChain } from 'viem'
import { PRIVY_APP_ID, isPrivyConfigured } from './config'

const queryClient = new QueryClient()

const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet-rpc.monad.xyz'] },
  },
  blockExplorers: {
    default: { name: 'MonadVision', url: 'https://testnet.monadvision.com' },
  },
  testnet: true,
})

function buildWagmiConfig() {
  return createConfig({
    chains: [monadTestnet],
    transports: {
      [monadTestnet.id]: http('https://testnet-rpc.monad.xyz'),
    },
  })
}

function useAppTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    const read = () => {
      setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light')
    }
    read()
    const obs = new MutationObserver(read)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  return theme
}

function MonadedLogo() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span
        aria-hidden
        style={{
          width: 28,
          height: 28,
          borderRadius: 999,
          background: 'conic-gradient(from 180deg, #6e54ff, #b7a8ff, #6e54ff)',
          display: 'inline-block',
        }}
      />
      <span
        style={{
          fontFamily: '"Space Grotesk", system-ui, sans-serif',
          fontWeight: 700,
          fontSize: 18,
          letterSpacing: '-0.02em',
        }}
      >
        Monaded
      </span>
    </div>
  )
}

export function PrivyAppProvider({ children }: { children: ReactNode }) {
  const wagmiConfig = useMemo(() => buildWagmiConfig(), [])
  const theme = useAppTheme()

  if (!isPrivyConfigured()) {
    // Allow the app to boot before Juan creates the Privy App ID.
    return <>{children}</>
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['email', 'google', 'twitter'],
        appearance: {
          walletChainType: 'ethereum-only',
          theme,
          accentColor: '#6E54FF',
          logo: <MonadedLogo />,
        },
        embeddedWallets: {
          ethereum: {
            createOnLogin: 'users-without-wallets',
          },
        },
        defaultChain: monadTestnet,
        supportedChains: [monadTestnet],
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  )
}
