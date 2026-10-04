/**
 * TemplateMarketplace event ABI fragments used for decoding eth_getLogs.
 * Keep in sync with contracts/abi/TemplateMarketplace.json.
 */
export const marketplaceEventsAbi = [
  {
    type: 'event',
    name: 'TemplatePublished',
    inputs: [
      { name: 'templateId', type: 'uint256', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'parentId', type: 'uint256', indexed: true },
      { name: 'price', type: 'uint256', indexed: false },
      { name: 'paymentToken', type: 'address', indexed: false },
      { name: 'metadataURI', type: 'string', indexed: false },
      { name: 'publisher', type: 'address', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TemplateUpdated',
    inputs: [
      { name: 'templateId', type: 'uint256', indexed: true },
      { name: 'price', type: 'uint256', indexed: false },
      { name: 'metadataURI', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Purchased',
    inputs: [
      { name: 'templateId', type: 'uint256', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'paymentToken', type: 'address', indexed: false },
      { name: 'price', type: 'uint256', indexed: false },
      { name: 'creatorAmount', type: 'uint256', indexed: false },
      { name: 'platformFee', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RoyaltyPaid',
    inputs: [
      { name: 'templateId', type: 'uint256', indexed: true },
      { name: 'ancestorId', type: 'uint256', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'level', type: 'uint256', indexed: false },
      { name: 'paymentToken', type: 'address', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PaymentDeferred',
    inputs: [
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Withdrawn',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TransferSingle',
    inputs: [
      { name: 'operator', type: 'address', indexed: true },
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'id', type: 'uint256', indexed: false },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TransferBatch',
    inputs: [
      { name: 'operator', type: 'address', indexed: true },
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'ids', type: 'uint256[]', indexed: false },
      { name: 'values', type: 'uint256[]', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'FeeConfigUpdated',
    inputs: [
      { name: 'royaltyBps', type: 'uint256', indexed: false },
      { name: 'platformFeeBps', type: 'uint256', indexed: false },
      { name: 'feeRecipient', type: 'address', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AcceptedTokenUpdated',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'accepted', type: 'bool', indexed: false },
    ],
  },
] as const

/** Events we forward to the api Worker (skip AccessControl noise). */
export const INDEXED_EVENT_NAMES = new Set([
  'TemplatePublished',
  'TemplateUpdated',
  'Purchased',
  'RoyaltyPaid',
  'PaymentDeferred',
  'Withdrawn',
  'TransferSingle',
  'TransferBatch',
  'FeeConfigUpdated',
  'AcceptedTokenUpdated',
])
