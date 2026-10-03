#!/usr/bin/env bash
# Live smoke test for TemplateMarketplace using cast.
#   1. deployer funds a fresh buyer wallet with a small amount of MON
#   2. relayer publishes original template A via publishFor (creator = CREATOR_A)
#   3. buyer buys A                         -> CREATOR_A receives 100%
#   4. relayer publishes fork B of A via publishFor (creator = a fresh "forker" wallet)
#   5. buyer buys B                         -> forker receives 90%, CREATOR_A receives 10% royalty
# Usage: MARKET=0x... [CREATOR_A=0x...] [PRICE_A_WEI=...] [PRICE_B_WEI=...] ./script/smoke-test.sh
# Reads the deployer/relayer key from ../../monad-deployer.env by default (never printed).
set -euo pipefail

ENV_FILE="${ENV_FILE:-$(cd "$(dirname "$0")/../../.." && pwd)/monad-deployer.env}"
# shellcheck disable=SC1090
source "$ENV_FILE"
RPC="${RPC_URL:-https://testnet-rpc.monad.xyz}"
: "${MARKET:?set MARKET to the deployed TemplateMarketplace address}"
PK="$MONAD_DEPLOYER_PRIVATE_KEY"
DEPLOYER="$MONAD_DEPLOYER_ADDRESS"
CREATOR_A="${CREATOR_A:-$DEPLOYER}"

PRICE_A="${PRICE_A_WEI:-10000000000000000}"   # 0.01 MON
PRICE_B="${PRICE_B_WEI:-10000000000000000}"   # 0.01 MON
# Monad charges the full gas limit, so use explicit, modest limits instead of large defaults.
# Measured on testnet: publishFor ~131k, buy (fork, 1 royalty level) ~150k.
GAS_PUBLISH="${GAS_PUBLISH:-200000}"
GAS_BUY="${GAS_BUY:-200000}"
# Explicit EIP-1559 fees (testnet base fee is ~100 gwei). The RPC rejects a tx unless
# balance >= value + gasLimit * maxFeePerGas, so the buyer funding is derived from these.
MAX_FEE="${MAX_FEE_WEI:-120000000000}"        # 120 gwei
PRIORITY_FEE="${PRIORITY_FEE_WEI:-2000000000}" # 2 gwei
FEES=(--gas-price "$MAX_FEE" --priority-gas-price "$PRIORITY_FEE")
FUND="${FUND_WEI:-$(python3 -c "print($PRICE_A + $PRICE_B + 2 * $GAS_BUY * $MAX_FEE + 5 * 10**15)")}"

new_wallet() { cast wallet new --json | python3 -c 'import json,sys;d=json.load(sys.stdin);d=d.get("data",d);d=d[0] if isinstance(d,list) else d;print(d["address"], d.get("private_key") or d.get("privateKey"))'; }
read -r BUYER BUYER_PK < <(new_wallet)
read -r FORKER FORKER_PK < <(new_wallet)
# Persist the throwaway keys (chmod 600, outside the repo) so leftover funds can be recovered.
WALLETS_FILE="${WALLETS_FILE:-$(dirname "$ENV_FILE")/smoke-test-wallets-$(date +%Y%m%d%H%M%S).env}"
( umask 077; printf 'SMOKE_BUYER_ADDRESS=%s\nSMOKE_BUYER_PRIVATE_KEY=%s\nSMOKE_FORKER_ADDRESS=%s\nSMOKE_FORKER_PRIVATE_KEY=%s\n' \
  "$BUYER" "$BUYER_PK" "$FORKER" "$FORKER_PK" > "$WALLETS_FILE" )
echo "throwaway wallet keys saved to $WALLETS_FILE"
echo "market:    $MARKET"
echo "creator A: $CREATOR_A"
echo "forker:    $FORKER"
echo "buyer:     $BUYER"

# cast >= 1.8 may wrap JSON output as {"success": ..., "data": ..., "errors": [...]}; fail loudly on errors.
tx() { cast send --json --rpc-url "$RPC" "${FEES[@]}" "$@" | python3 -c '
import json, sys
r = json.load(sys.stdin)
if isinstance(r, dict) and "success" in r:
    if not r["success"]:
        sys.exit("cast send failed: " + "; ".join(e.get("message", "") for e in r.get("errors", [])))
    r = r["data"]
if int(r["status"], 16) != 1:
    sys.exit("transaction reverted: " + r["transactionHash"])
print(r["transactionHash"], "gasUsed=" + str(int(r["gasUsed"], 16)), "effectiveGasPrice=" + str(int(r["effectiveGasPrice"], 16)))'; }
bal() { cast balance "$1" --rpc-url "$RPC"; }
# Big-int safe arithmetic (wei values overflow bash 64-bit integers).
calc() { python3 -c "print($1)"; }

echo "== fund buyer with $FUND wei"
tx --private-key "$PK" "$BUYER" --value "$FUND" --gas-limit 21000
NEXT=$(cast call "$MARKET" "nextTemplateId()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
A=$NEXT; B=$((NEXT + 1))

C0=$(bal "$CREATOR_A"); F0=$(bal "$FORKER"); U0=$(bal "$BUYER")

echo "== publishFor A (id $A, creator $CREATOR_A, price $PRICE_A)"
tx --private-key "$PK" --gas-limit "$GAS_PUBLISH" "$MARKET" "publishFor(address,uint256,uint256,string)" "$CREATOR_A" "$PRICE_A" 0 "ipfs://smoke-test/original.json"
echo "== buy A"
tx --private-key "$BUYER_PK" --gas-limit "$GAS_BUY" "$MARKET" "buy(uint256)" "$A" --value "$PRICE_A"
C1=$(bal "$CREATOR_A")
echo "creator A delta after buy A: $(calc "$C1 - $C0") wei (expected $PRICE_A)"

echo "== publishFor fork B (id $B, parent $A, creator $FORKER, price $PRICE_B)"
tx --private-key "$PK" --gas-limit "$GAS_PUBLISH" "$MARKET" "publishFor(address,uint256,uint256,string)" "$FORKER" "$PRICE_B" "$A" "ipfs://smoke-test/fork.json"
echo "== buy B"
tx --private-key "$BUYER_PK" --gas-limit "$GAS_BUY" "$MARKET" "buy(uint256)" "$B" --value "$PRICE_B"
C2=$(bal "$CREATOR_A"); F2=$(bal "$FORKER"); U2=$(bal "$BUYER")

echo "creator A royalty delta after buy B: $(calc "$C2 - $C1") wei (expected $(calc "$PRICE_B // 10"))"
echo "creator A total delta: $(calc "$C2 - $C0") wei"
echo "forker delta: $(calc "$F2 - $F0") wei (expected $(calc "$PRICE_B - $PRICE_B // 10"))"
echo "buyer delta (prices + gas): $(calc "$U2 - $U0") wei; remaining buyer balance $U2 wei"
echo "buyer licenses: A=$(cast call "$MARKET" "balanceOf(address,uint256)(uint256)" "$BUYER" "$A" --rpc-url "$RPC") B=$(cast call "$MARKET" "balanceOf(address,uint256)(uint256)" "$BUYER" "$B" --rpc-url "$RPC")"
echo "market balance: $(bal "$MARKET") wei (expected 0)"
