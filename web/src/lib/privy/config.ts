/** Privy + wagmi config for Monad testnet. Keep this isolated for clean merges with UI work. */

export const PRIVY_APP_ID: string = (import.meta.env.VITE_PRIVY_APP_ID as string | undefined) ?? ''

export const MONAD_TESTNET = {
  id: 10143,
  name: 'Monad Testnet',
  network: 'monad-testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet-rpc.monad.xyz'] },
    public: { http: ['https://testnet-rpc.monad.xyz'] },
  },
  blockExplorers: {
    default: { name: 'MonadVision', url: 'https://testnet.monadvision.com' },
  },
  testnet: true,
} as const

export const MARKETPLACE_ADDRESS =
  (import.meta.env.VITE_MARKETPLACE_ADDRESS as string | undefined) ??
  '0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e'

export const isPrivyConfigured = (): boolean => Boolean(PRIVY_APP_ID && PRIVY_APP_ID !== 'your-privy-app-id')
