import { createWalletClient, custom, getAddress, type Address, type WalletClient } from 'viem'
import { MONAD_CHAIN_ID, MONAD_RPC_URL } from './constants'

type PrivyWallet = {
  address: string
  chainId?: string | number
  switchChain?: (chainId: number) => Promise<void>
  getEthereumProvider: () => Promise<unknown>
}

const monadChain = {
  id: MONAD_CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [MONAD_RPC_URL] } },
} as const

/** Build a viem WalletClient from a Privy embedded wallet on Monad testnet. */
export async function walletClientFromPrivy(
  wallet: PrivyWallet,
  preferredAddress?: string | null,
): Promise<{ walletClient: WalletClient; account: Address }> {
  const account = getAddress(preferredAddress || wallet.address)
  if (wallet.switchChain) {
    try {
      await wallet.switchChain(MONAD_CHAIN_ID)
    } catch {
      // Provider may already be on Monad; continue.
    }
  }
  const provider = await wallet.getEthereumProvider()
  const walletClient = createWalletClient({
    account,
    chain: monadChain,
    transport: custom(provider as Parameters<typeof custom>[0]),
  })
  return { walletClient, account }
}

export function pickEmbeddedWallet(
  wallets: PrivyWallet[],
  sessionAddress?: string | null,
): PrivyWallet | null {
  if (!wallets.length) return null
  if (sessionAddress) {
    const match = wallets.find((w) => w.address.toLowerCase() === sessionAddress.toLowerCase())
    if (match) return match
  }
  return wallets[0] ?? null
}
