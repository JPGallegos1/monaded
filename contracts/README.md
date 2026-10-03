# edtech-monad contracts

Solidity contracts for the onchain study-template marketplace on **Monad**.
Built with Foundry (>= 1.8, `network = "monad"`) and OpenZeppelin Contracts v5.4.

## Status / addresses

| Network | Chain ID | TemplateMarketplace | Explorer |
| --- | --- | --- | --- |
| Monad testnet | 10143 | _not deployed yet (deployer wallet awaiting faucet funds)_ | https://testnet.monadvision.com |

- Deployer / admin / relayer (testnet only): `0x11de6e9D9Df8ed95f54CA35448a359a4f4a22e40`
- Predicted marketplace address if the deploy is the deployer's first transaction (nonce 0):
  `0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e` (confirm in `broadcast/Deploy.s.sol/10143/run-latest.json`).
- Network info (from https://docs.monad.xyz/developer-essentials/testnets):
  RPC `https://testnet-rpc.monad.xyz`, explorers https://testnet.monadvision.com and
  https://testnet.monadscan.com, faucet https://faucet.monad.xyz.

## Design

`src/TemplateMarketplace.sol` is a single contract: **ERC-1155 + AccessControl + ReentrancyGuard**.

- Each template is an ERC-1155 token id (ids start at 1; `0` means "no parent").
- `Template { creator, paymentToken, price, parentId, metadataURI }`.
  `paymentToken == address(0)` means native MON (wei).
- `publishTemplate(price, parentId, uri)` - caller becomes the creator.
- `publishFor(creator, price, parentId, uri)` - `RELAYER_ROLE` only; lets the backend publish
  on behalf of a creator address without the user signing.
- `updateTemplate(id, price, uri)` - creator or relayer. Currency and parent are immutable.
- `buy(id)` payable - `msg.value` must equal `price` exactly; mints 1 license to `msg.sender`
  and splits the payment in the same transaction.
- `buyWithToken(id)` - same for ERC-20 templates (token must be allowlisted by the admin via
  `setAcceptedToken`; `MockUSDC` is provided for tests/testnet).
- `previewSplit(id)` - returns `(recipients[], amounts[])` for a sale (creator first).
- `hasLicense(account, id)` / `balanceOf(account, id)` - license check for gating content.

### Payment split

```
fee      = price * platformFeeBps / 10_000          (default 0, sent to feeRecipient)
net      = price - fee
perLevel = net * royaltyBps / 10_000                (default 1000 = 10%)
ancestors (parent, grandparent, great-grandparent; max 3 levels) each get perLevel
creator  = net - perLevel * depth                   (keeps rounding dust)
```

Example with defaults, fork chain `A <- B <- C <- D <- E`, buying `E` for 1 MON:
E 0.7, D 0.1, C 0.1, B 0.1, A 0 (beyond 3 levels).
The admin can change `royaltyBps`, `platformFeeBps` and `feeRecipient`, but
`platformFeeBps + 3 * royaltyBps <= 5000`, so the creator always keeps at least 50%.

### Push payments with pull fallback

Every recipient is paid directly in the purchase transaction (native: `call` with a 50k gas cap,
ERC-20: non-reverting `transfer`). If a push fails (recipient reverts or burns gas), the amount is
credited to `pendingWithdrawals[token][recipient]` and `PaymentDeferred` is emitted; the purchase
still succeeds. Recipients claim with `withdraw()`, `withdrawTo(to)` or `withdrawToken(token)`.
All state-changing payment paths are `nonReentrant`.

### Events

`TemplatePublished(templateId, creator, parentId, price, paymentToken, metadataURI, publisher)`,
`Purchased(templateId, buyer, creator, paymentToken, price, creatorAmount, platformFee)`,
`RoyaltyPaid(templateId, ancestorId, recipient, level, paymentToken, amount)`,
`PaymentDeferred`, `Withdrawn`, `TemplateUpdated`, `FeeConfigUpdated`, `AcceptedTokenUpdated`,
plus the standard ERC-1155 `TransferSingle` / `URI` and AccessControl events.

### Roles

- `DEFAULT_ADMIN_ROLE` (`0x00...00`): fee config, token allowlist, grant/revoke roles.
- `RELAYER_ROLE` = `keccak256("RELAYER_ROLE")`: `publishFor`, `publishForERC20`, `updateTemplate`.

## ABI

Committed JSON ABIs (regenerate after changes, see below):

- `abi/TemplateMarketplace.json`
- `abi/MockUSDC.json`

```sh
forge build
jq '.abi' out/TemplateMarketplace.sol/TemplateMarketplace.json > abi/TemplateMarketplace.json
jq '.abi' out/MockUSDC.sol/MockUSDC.json > abi/MockUSDC.json
```

## Setup, test, deploy

Dependencies are installed with npm (no git submodules):

```sh
cd contracts
npm ci                 # @openzeppelin/contracts 5.4.0 + forge-std 1.11.0
forge build
forge test -vv
```

Deploy to Monad testnet (key lives outside the repo):

```sh
set -a; source ../../monad-deployer.env; set +a   # MONAD_DEPLOYER_PRIVATE_KEY, MONAD_DEPLOYER_ADDRESS
cast balance $MONAD_DEPLOYER_ADDRESS --ether --rpc-url monad_testnet
forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
# Optional env: RELAYER_ADDRESS, ROYALTY_BPS (1000), PLATFORM_FEE_BPS (0), FEE_RECIPIENT, DEPLOY_MOCK_USDC=true
```

Verify on MonadVision (Sourcify):

```sh
forge verify-contract <MARKET_ADDRESS> src/TemplateMarketplace.sol:TemplateMarketplace \
  --chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/ \
  --constructor-args $(cast abi-encode "constructor(address,address,uint256,uint256,address)" \
     $MONAD_DEPLOYER_ADDRESS $MONAD_DEPLOYER_ADDRESS 1000 0 $MONAD_DEPLOYER_ADDRESS)
```

Live smoke test (publish via relayer, buy from a fresh wallet, fork + buy, check the royalty split):

```sh
MARKET=<MARKET_ADDRESS> ./script/smoke-test.sh
```

Note: Monad charges gas by **gas limit**, not gas used. The full deploy estimate is ~3.9M gas
(~0.8 MON at 203 gwei max fee on testnet), so fund the deployer with at least ~1.5 MON to cover deploy + smoke test.

## Calling it from the Python API

The backend acts as the **relayer**: it signs `publishFor` transactions with the relayer key and reads
state with `eth_call`. Buyers call `buy(id)` from their own wallet in the web app (viem/wagmi).

Recommended approach for a Cloudflare **Python** Worker (Pyodide): raw JSON-RPC over `fetch`
plus `eth-account` for local signing. `web3.py` pulls in native/async networking dependencies
(aiohttp, websockets, etc.) that are not reliable on Pyodide; JSON-RPC over HTTP is just a few POSTs.
If `eth-account` (it depends on `pycryptodome`/`coincurve`-style crypto) fails to load in Pyodide,
fall back to a tiny TypeScript Worker using `viem` as the signer, called through a Service Binding.

Minimal relayer flow (pseudo-Python):

```python
from eth_account import Account
from eth_abi import encode
from eth_utils import keccak, to_checksum_address

RPC = "https://testnet-rpc.monad.xyz"
CHAIN_ID = 10143
MARKET = "0x..."                          # from the table above
relayer = Account.from_key(env.MONAD_RELAYER_PRIVATE_KEY)  # Worker secret, never in code

def selector(sig: str) -> bytes:
    return keccak(text=sig)[:4]

async def rpc(method, params):
    r = await fetch(RPC, method="POST", headers={"content-type": "application/json"},
                    body=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
    data = await r.json()
    if "error" in data: raise RuntimeError(data["error"])
    return data["result"]

async def publish_for(creator: str, price_wei: int, parent_id: int, uri: str) -> str:
    data = selector("publishFor(address,uint256,uint256,string)") + encode(
        ["address", "uint256", "uint256", "string"], [to_checksum_address(creator), price_wei, parent_id, uri])
    nonce = int(await rpc("eth_getTransactionCount", [relayer.address, "pending"]), 16)
    tx = {"to": MARKET, "data": "0x" + data.hex(), "value": 0, "chainId": CHAIN_ID, "nonce": nonce}
    gas = int(await rpc("eth_estimateGas", [{"from": relayer.address, **{k: tx[k] for k in ("to", "data")}}]), 16)
    tx["gas"] = gas * 12 // 10            # small buffer; Monad charges the full gas limit
    base = int((await rpc("eth_getBlockByNumber", ["latest", False]))["baseFeePerGas"], 16)
    tx["maxPriorityFeePerGas"] = 2 * 10**9
    tx["maxFeePerGas"] = base * 2 + tx["maxPriorityFeePerGas"]
    signed = relayer.sign_transaction(tx)
    return await rpc("eth_sendRawTransaction", ["0x" + signed.raw_transaction.hex()])
```

Then poll `eth_getTransactionReceipt(txHash)` and read the new id from the `TemplatePublished` log:
`topics[0] = keccak256("TemplatePublished(uint256,address,uint256,uint256,address,string,address)")`,
`topics[1] = templateId`, `topics[2] = creator`, `topics[3] = parentId`.

Useful reads (`eth_call`):

| Call | Signature |
| --- | --- |
| License check | `hasLicense(address,uint256)(bool)` |
| Template data | `getTemplate(uint256)((address,address,uint256,uint256,string))` |
| Split preview | `previewSplit(uint256)(address[],uint256[])` |
| Next id | `nextTemplateId()(uint256)` |
| Pending payouts | `pendingWithdrawals(address,address)(uint256)` (token `0x0` = MON) |

Nonce management: the relayer is a single EOA, so serialize `publishFor` calls (e.g. a Durable
Object or a queue) or use the `pending` nonce and retry on "nonce too low".
