/** Marketplace chain + contract constants (Monad testnet). */

export const MONAD_CHAIN_ID = 10143 as const

export const MONAD_RPC_URL = 'https://testnet-rpc.monad.xyz'

export const MARKETPLACE_ADDRESS = (
  (import.meta.env.VITE_MARKETPLACE_ADDRESS as string | undefined) ??
  '0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e'
) as `0x${string}`

/** Relayer that signs publishFor. Lineage is trusted only when TemplatePublished.publisher == this. */
export const RELAYER_ADDRESS =
  '0x2b1A7A88061AcE8d23bf3f1354384592b72c2A67' as `0x${string}`

export const EXPLORER_TX_BASE = 'https://testnet.monadvision.com/tx'

export const EXPLORER_ADDRESS_BASE = 'https://testnet.monadvision.com/address'

/** Royalty per ancestor level (matches onchain royaltyBps = 1000). */
export const ROYALTY_BPS_PER_LEVEL = 1000

export const MAX_LINEAGE_DEPTH = 3

/** Gas buffer: Monad charges the full gas limit — use estimate + 20%, never a fixed 200k. */
export const GAS_BUFFER_BPS = 12000 // 20% → multiply by 1.2

/** Native MON sentinel for pendingWithdrawals / paymentToken (address(0)). */
export const NATIVE_PAYMENT_TOKEN = '0x0000000000000000000000000000000000000000' as `0x${string}`
