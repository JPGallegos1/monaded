#!/usr/bin/env bash
# Live smoke test for TemplateMarketplace using cast.
#   1. relayer publishes template A on behalf of the deployer (creator A)
#   2. a fresh buyer wallet (funded with a tiny amount by the deployer) buys A
#   3. relayer publishes fork B (creator = a fresh "forker" wallet, parent = A)
#   4. buyer buys B -> forker gets 90%, creator A gets 10% royalty
# Usage: MARKET=0x... ./script/smoke-test.sh   (reads ../../monad-deployer.env by default)
set -euo pipefail

ENV_FILE="${ENV_FILE:-$(cd "$(dirname "$0")/../../.." && pwd)/monad-deployer.env}"
# shellcheck disable=SC1090
source "$ENV_FILE"
RPC="${RPC_URL:-https://testnet-rpc.monad.xyz}"
: "${MARKET:?set MARKET to the deployed TemplateMarketplace address}"
PK="$MONAD_DEPLOYER_PRIVATE_KEY"
DEPLOYER="$MONAD_DEPLOYER_ADDRESS"

PRICE="${PRICE_WEI:-1000000000000000}"     # 0.001 MON
FUND="${FUND_WEI:-50000000000000000}"      # 0.05 MON for buyer gas + 2 purchases

new_wallet() { cast wallet new --json | python3 -c 'import json,sys;d=json.load(sys.stdin);d=d.get("data",d);d=d[0] if isinstance(d,list) else d;print(d["address"], d.get("private_key") or d.get("privateKey"))'; }
read -r BUYER BUYER_PK < <(new_wallet)
read -r FORKER _FORKER_PK < <(new_wallet)
echo "buyer:  $BUYER"
echo "forker: $FORKER"

tx() { cast send --json --rpc-url "$RPC" "$@" | python3 -c 'import json,sys;r=json.load(sys.stdin);print(r["transactionHash"], r["status"])'; }
bal() { cast balance "$1" --rpc-url "$RPC"; }
# Big-int safe arithmetic (wei values overflow bash 64-bit integers).
calc() { python3 -c "print($1)"; }

echo "== fund buyer";             tx --private-key "$PK" "$BUYER" --value "$FUND"
NEXT=$(cast call "$MARKET" "nextTemplateId()(uint256)" --rpc-url "$RPC")
A=$NEXT; B=$((NEXT + 1))
echo "== publishFor A (id $A)";   tx --private-key "$PK" "$MARKET" "publishFor(address,uint256,uint256,string)" "$DEPLOYER" "$PRICE" 0 "ipfs://smoke-test/original.json"

D0=$(bal "$DEPLOYER"); F0=$(bal "$FORKER")
echo "== buy A";                  tx --private-key "$BUYER_PK" "$MARKET" "buy(uint256)" "$A" --value "$PRICE"
D1=$(bal "$DEPLOYER")
echo "creator A delta after buy A: $(calc "$D1 - $D0") wei (expected $PRICE)"

echo "== publishFor fork B (id $B, parent $A)"; tx --private-key "$PK" "$MARKET" "publishFor(address,uint256,uint256,string)" "$FORKER" "$PRICE" "$A" "ipfs://smoke-test/fork.json"
D2=$(bal "$DEPLOYER")
echo "== buy B";                  tx --private-key "$BUYER_PK" "$MARKET" "buy(uint256)" "$B" --value "$PRICE"
D3=$(bal "$DEPLOYER"); F3=$(bal "$FORKER")
echo "creator A royalty delta after buy B: $(calc "$D3 - $D2") wei (expected $(calc "$PRICE // 10"))"
echo "forker delta after buy B: $(calc "$F3 - $F0") wei (expected $(calc "$PRICE - $PRICE // 10"))"
echo "buyer licenses: A=$(cast call "$MARKET" "balanceOf(address,uint256)(uint256)" "$BUYER" "$A" --rpc-url "$RPC") B=$(cast call "$MARKET" "balanceOf(address,uint256)(uint256)" "$BUYER" "$B" --rpc-url "$RPC")"
echo "market balance: $(bal "$MARKET") wei (expected 0)"
