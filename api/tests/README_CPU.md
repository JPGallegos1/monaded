# CPU cost note: Privy ES256 JWT verification
#
# Decision: verify via WebCrypto (`crypto.subtle.verify`, ECDSA P-256 / SHA-256)
# through the Python Workers JS FFI (`from js import crypto`). Pure-Python EC
# (e.g. ecdsa/cryptography) is too slow / may be unavailable under Workers Free
# (10 ms CPU / request).
#
# Measurement (Node 22 WebCrypto, same algorithm), 500 iterations of
# importKey(jwk)+verify on a warm process:
#
#   { "iterations": 500, "total_ms": 153.82, "per_verify_ms": 0.3076 }
#
# ~0.3 ms per verify leaves headroom under the 10 ms Free budget even with
# JWKS cache hits + claim checks. secp256k1 publishFor signing is delegated to
# the TypeScript `chain/` Worker for the same reason.
#
# Reproduce: `node api/tests/measure_webcrypto_es256.mjs`
