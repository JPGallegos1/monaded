/**
 * Micro-benchmark: ECDSA P-256 / SHA-256 verify cost (same algorithm Privy ES256 uses).
 * Run: node api/tests/measure_webcrypto_es256.mjs
 *
 * Workers Free budget is ~10 ms CPU per request. WebCrypto is native and should
 * leave headroom; pure-Python EC typically does not.
 */
import { webcrypto } from 'node:crypto'

const { subtle } = webcrypto

async function main() {
  const { privateKey, publicKey } = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const data = new TextEncoder().encode('header.payload')
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data)
  const jwk = await subtle.exportKey('jwk', publicKey)

  const N = 500
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    const key = await subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data)
    if (!ok) throw new Error('verify failed')
  }
  const ms = performance.now() - t0
  const per = ms / N
  console.log(JSON.stringify({
    iterations: N,
    total_ms: Number(ms.toFixed(2)),
    per_verify_ms: Number(per.toFixed(4)),
    note: 'WebCrypto ECDSA P-256/SHA-256 (Privy ES256). Expect << 10ms Workers Free budget per request.',
  }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
