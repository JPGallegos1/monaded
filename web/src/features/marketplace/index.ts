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
} from './client'
export { applyGasBuffer } from './gas'
export {
  monToWei,
  weiToMon,
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
} from './api'
export type {
  OnchainTemplate,
  SplitRow,
  LineageAncestor,
  TemplateLineage,
  BuyResult,
  PublishResult,
  MarketplaceListFilters,
  PublicSectionRef,
  PublicSectionOutline,
} from './types'

export { useOnchainTemplate } from './hooks/useOnchainTemplate'
export { useBuyTemplate } from './hooks/useBuyTemplate'
export { usePublishTemplate } from './hooks/usePublishTemplate'
export { useLibraryLicenses } from './hooks/useLibraryLicenses'
export { useLineage } from './hooks/useLineage'
export { useForkTemplate } from './hooks/useForkTemplate'
export { useMarketplaceCatalog } from './hooks/useMarketplaceCatalog'

export { PublishForm } from './components/PublishForm'
export { BuyPanel } from './components/BuyPanel'
export { SplitPreview } from './components/SplitPreview'
export { LineageView, lineageToNodeData } from './components/LineageView'
export {
  useGatedContent,
  GatedContentBanner,
  getPublicSectionOutline,
} from './components/GatedContent'
export type { TemplatePreview } from './components/GatedContent'
