/** Marketplace bounded context — hooks, contract client, thin UI. */

export { templateMarketplaceAbi } from './abi'
export {
  MARKETPLACE_ADDRESS,
  MONAD_CHAIN_ID,
  MONAD_RPC_URL,
  RELAYER_ADDRESS,
  EXPLORER_TX_BASE,
  ROYALTY_BPS_PER_LEVEL,
  MAX_LINEAGE_DEPTH,
  NATIVE_PAYMENT_TOKEN,
} from './constants'
export {
  getMarketplacePublicClient,
  readExists,
  readGetTemplate,
  readUri,
  readHasLicense,
  readBalanceOf,
  readPreviewSplit,
  readLineage,
  isRelayerPublished,
  buyTemplate,
  waitForTx,
  readPendingWithdrawals,
  withdrawPending,
} from './client'
export { applyGasBuffer } from './gas'
export {
  monToWei,
  weiToMon,
  weiToMonDisplay,
  txExplorerUrl,
  addressExplorerUrl,
  shortAddress,
  isInsufficientFundsError,
} from './format'
export { walletClientFromPrivy, pickEmbeddedWallet } from './wallet'
export {
  publishTemplateOnchain,
  verifyPurchaseTx,
  getGatedTemplateContent,
  forkTemplate,
  getTemplates,
  getTemplate,
  getMyEarnings,
} from './api'
export type {
  OnchainTemplate,
  SplitRow,
  LineageAncestor,
  TemplateLineage,
  BuyResult,
  PublishResult,
  MarketplaceListFilters,
} from './types'
export type {
  MeEarningsResponse,
  MeEarningsRecentItem,
  MeEarningsTotals,
} from './types-earnings'

export { useOnchainTemplate } from './hooks/useOnchainTemplate'
export { useBuyTemplate } from './hooks/useBuyTemplate'
export { usePublishTemplate } from './hooks/usePublishTemplate'
export { useLibraryLicenses } from './hooks/useLibraryLicenses'
export { useLineage } from './hooks/useLineage'
export { useForkTemplate } from './hooks/useForkTemplate'
export { useMarketplaceCatalog } from './hooks/useMarketplaceCatalog'
export { useMyEarnings } from './hooks/useMyEarnings'
export { usePendingWithdrawal } from './hooks/usePendingWithdrawal'
export { useWithdrawEarnings } from './hooks/useWithdrawEarnings'

export { PublishForm } from './components/PublishForm'
export { BuyPanel } from './components/BuyPanel'
export { SplitPreview } from './components/SplitPreview'
export { LineageView, lineageToNodeData } from './components/LineageView'
export { useGatedContent, GatedContentBanner } from './components/GatedContent'
