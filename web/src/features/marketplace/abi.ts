/**
 * Minimal TemplateMarketplace ABI for marketplace web reads/writes.
 * Full ABI lives in contracts/abi/TemplateMarketplace.json — keep this fragment
 * in sync with view/payable methods the UI uses.
 */
export const templateMarketplaceAbi = [
  {
    type: 'function',
    name: 'getTemplate',
    stateMutability: 'view',
    inputs: [{ name: 'templateId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'creator', type: 'address' },
          { name: 'paymentToken', type: 'address' },
          { name: 'price', type: 'uint256' },
          { name: 'parentId', type: 'uint256' },
          { name: 'metadataURI', type: 'string' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'exists',
    stateMutability: 'view',
    inputs: [{ name: 'templateId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'uri',
    stateMutability: 'view',
    inputs: [{ name: 'templateId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'hasLicense',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'templateId', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'previewSplit',
    stateMutability: 'view',
    inputs: [{ name: 'templateId', type: 'uint256' }],
    outputs: [
      { name: 'recipients', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
  },
  {
    type: 'function',
    name: 'buy',
    stateMutability: 'payable',
    inputs: [{ name: 'templateId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'nextTemplateId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
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
] as const
