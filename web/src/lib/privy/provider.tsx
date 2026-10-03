/**
 * Privy provider wired to wagmi on Monad testnet.
 * Isolated module — UI agents should wrap the app with <PrivyAppProvider> only.
 */
import { type ReactNode, useMemo } from 'react'
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

export function PrivyAppProvider({ children }: { children: ReactNode }) {
  const wagmiConfig = useMemo(() => buildWagmiConfig(), [])

  if (!isPrivyConfigured()) {
    // Allow the app to boot before Juan creates the Privy App ID.
    return <>{children}</>
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['email'],
        appearance: { walletChainType: 'ethereum-only' },
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
