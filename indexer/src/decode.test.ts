import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  http,
  parseAbiParameters,
  type Hex,
  type Log,
} from 'viem'
import { marketplaceEventsAbi } from './abi'
import { decodeMarketplaceLog, decodeMarketplaceLogs } from './decode'

const __dirname = dirname(fileURLToPath(import.meta.url))

function publishedLog(args: {
  templateId: bigint
  creator: `0x${string}`
  parentId: bigint
  price: bigint
  paymentToken: `0x${string}`
  metadataURI: string
  publisher: `0x${string}`
  blockNumber: bigint
  logIndex: number
  tx: Hex
}): Log {
  const topics = encodeEventTopics({
    abi: marketplaceEventsAbi,
    eventName: 'TemplatePublished',
    args: {
      templateId: args.templateId,
      creator: args.creator,
      parentId: args.parentId,
    },
  })
  const data = encodeAbiParameters(
    parseAbiParameters('uint256 price, address paymentToken, string metadataURI, address publisher'),
    [args.price, args.paymentToken, args.metadataURI, args.publisher],
  )
  return {
    address: '0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e',
    blockHash: ('0x' + '22'.repeat(32)) as Hex,
    blockNumber: args.blockNumber,
    data,
    logIndex: args.logIndex,
    transactionHash: args.tx,
    transactionIndex: 0,
    topics: topics as [Hex, ...Hex[]],
    removed: false,
  } as Log
}

test('decodeMarketplaceLog lowercases addresses and stringifies uints', () => {
  const log = publishedLog({
    templateId: 2n,
    creator: '0x039ee5a5e40C9853621689CA3D46e8C9De7c887a',
    parentId: 1n,
    price: 10000000000000000n,
    paymentToken: '0x0000000000000000000000000000000000000000',
    metadataURI: 'ipfs://smoke-test/fork.json',
    publisher: '0x11de6e9D9Df8ed95f54CA35448a359a4f4a22e40',
    blockNumber: 67913315n,
    logIndex: 34,
    tx: '0x0f71e66e61adc531d193c4693e01be4562a839133cc15b91813bb011b7ba7d38',
  })

  const times = new Map([[67913315, 1728000000]])
  const ev = decodeMarketplaceLog(log, times)
  assert.ok(ev)
  assert.equal(ev!.event_name, 'TemplatePublished')
  assert.equal(ev!.args.templateId, '2')
  assert.equal(ev!.args.parentId, '1')
  assert.equal(ev!.args.creator, '0x039ee5a5e40c9853621689ca3d46e8c9de7c887a')
  assert.equal(ev!.args.paymentToken, '0x0000000000000000000000000000000000000000')
  assert.equal(ev!.block_time, 1728000000)
  assert.equal(ev!.tx_hash, '0x0f71e66e61adc531d193c4693e01be4562a839133cc15b91813bb011b7ba7d38')
})

test('decodeMarketplaceLogs sorts by block then log_index', () => {
  const deferredTopics = encodeEventTopics({
    abi: marketplaceEventsAbi,
    eventName: 'PaymentDeferred',
    args: {
      recipient: '0x83e24B4DfF93883f01456fCb86c3CD371Dc3Ea48',
      token: '0x0000000000000000000000000000000000000000',
    },
  })
  const deferredData = encodeAbiParameters(parseAbiParameters('uint256 amount'), [1n])
  const purchasedTopics = encodeEventTopics({
    abi: marketplaceEventsAbi,
    eventName: 'Purchased',
    args: {
      templateId: 1n,
      buyer: '0x26040A45bCcc47312D70c1A7653f08D82f4D1563',
      creator: '0x83e24B4DfF93883f01456fCb86c3CD371Dc3Ea48',
    },
  })
  const purchasedData = encodeAbiParameters(
    parseAbiParameters('address paymentToken, uint256 price, uint256 creatorAmount, uint256 platformFee'),
    ['0x0000000000000000000000000000000000000000', 10n, 10n, 0n],
  )
  const logs = [
    {
      address: '0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e',
      blockNumber: 100n,
      logIndex: 5,
      transactionHash: ('0x' + 'aa'.repeat(32)) as Hex,
      data: purchasedData,
      topics: purchasedTopics,
    },
    {
      address: '0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e',
      blockNumber: 100n,
      logIndex: 2,
      transactionHash: ('0x' + 'bb'.repeat(32)) as Hex,
      data: deferredData,
      topics: deferredTopics,
    },
  ] as Log[]
  const decoded = decodeMarketplaceLogs(logs)
  assert.equal(decoded.length, 2)
  assert.equal(decoded[0].event_name, 'PaymentDeferred')
  assert.equal(decoded[0].log_index, 2)
  assert.equal(decoded[1].event_name, 'Purchased')
  assert.equal(decoded[1].log_index, 5)
})

test('dry-run: real TemplatePublished×3 and Purchased 0x361a…0aa2 from deploy block', async (t) => {
  const rpc = process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz'
  const client = createPublicClient({ transport: http(rpc) })
  let tip: bigint
  try {
    tip = await client.getBlockNumber()
  } catch {
    t.skip('RPC unavailable')
    return
  }

  const CONTRACT = '0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e' as const
  const DEPLOY = 67913228n
  const all: Log[] = []
  let frm = DEPLOY
  let empty = 0
  let saw = false
  while (frm <= tip && frm < DEPLOY + 50000n) {
    const to = frm + 99n > tip ? tip : frm + 99n
    const logs = await client.getLogs({ address: CONTRACT, fromBlock: frm, toBlock: to })
    if (logs.length) {
      saw = true
      empty = 0
      all.push(...logs)
    } else if (saw) {
      empty++
      if (empty >= 250) break
    }
    frm = to + 1n
  }

  const decoded = decodeMarketplaceLogs(all)
  const published = decoded.filter((e) => e.event_name === 'TemplatePublished')
  const purchased = decoded.filter((e) => e.event_name === 'Purchased')
  assert.equal(published.length, 3)
  const t2 = published.find((e) => e.args.templateId === '2')
  assert.ok(t2)
  assert.equal(t2!.args.parentId, '1')
  const target = purchased.find(
    (e) => e.tx_hash === '0x361a57166f3f2dbe8f9faf341ff62e1317b1cbb9aa58f426dbbcad4634f80aa2',
  )
  assert.ok(target)
  assert.equal(target!.args.templateId, '1')

  const abiPath = join(__dirname, '../../contracts/abi/TemplateMarketplace.json')
  const abi = JSON.parse(readFileSync(abiPath, 'utf8')) as Array<{ name?: string; type?: string }>
  const purchasedAbi = abi.find((x) => x.name === 'Purchased' && x.type === 'event')
  assert.ok(purchasedAbi)
  const sample = all.find(
    (l) =>
      l.transactionHash?.toLowerCase() ===
        '0x361a57166f3f2dbe8f9faf341ff62e1317b1cbb9aa58f426dbbcad4634f80aa2' &&
      l.topics[0]?.toLowerCase() ===
        '0x56cc1e0da1e03045444aa9e0b296611b2f33c62704d401968e22e73e93c59159',
  )
  assert.ok(sample)
  const roundTrip = decodeEventLog({
    abi: [purchasedAbi!],
    data: sample!.data,
    topics: sample!.topics as [Hex, ...Hex[]],
  })
  assert.equal(roundTrip.eventName, 'Purchased')
})
