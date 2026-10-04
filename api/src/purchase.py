"""On-chain purchase verification against TemplateMarketplace on Monad testnet.

Before granting template access, the backend checks:
  - receipt.status == 1 (success)
  - a Purchased log from the TemplateMarketplace address
  - buyer in the event == session wallet
  - templateId in the event == requested on-chain id
Each tx hash is usable once (unique constraint in Supabase).
"""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, Optional

MONAD_RPC_DEFAULT = "https://testnet-rpc.monad.xyz"
MARKETPLACE_DEFAULT = "0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e"
# keccak256("Purchased(uint256,address,address,address,uint256,uint256,uint256)")
PURCHASED_TOPIC0 = "0x56cc1e0da1e03045444aa9e0b296611b2f33c62704d401968e22e73e93c59159"

FetchFn = Callable[..., Awaitable[Any]]


class PurchaseError(Exception):
    def __init__(self, message: str, *, code: str = "purchase_invalid"):
        super().__init__(message)
        self.message = message
        self.code = code


def _norm_addr(addr: str) -> str:
    if not isinstance(addr, str) or not addr.startswith("0x") or len(addr) != 42:
        raise PurchaseError("invalid address", code="bad_address")
    return addr.lower()


def _norm_tx(tx: str) -> str:
    if not isinstance(tx, str) or not tx.startswith("0x") or len(tx) != 66:
        raise PurchaseError("invalid tx hash", code="bad_tx")
    return tx.lower()


def _topic_address(topic: str) -> str:
    # topics are 32-byte hex; address is the last 20 bytes
    h = topic.lower()
    if h.startswith("0x"):
        h = h[2:]
    if len(h) != 64:
        raise PurchaseError("invalid log topic", code="bad_log")
    return "0x" + h[-40:]


def _topic_uint(topic: str) -> int:
    h = topic.lower()
    if h.startswith("0x"):
        h = h[2:]
    return int(h, 16)


def parse_purchased_logs(
    receipt: dict,
    *,
    marketplace: str,
    buyer: str,
    template_id: int,
) -> dict:
    """Validate receipt + Purchased event. Returns matched log fields."""
    status = receipt.get("status")
    # status may be "0x1" or 1
    ok = status in (1, "0x1", "0x01")
    if not ok:
        raise PurchaseError("transaction failed", code="bad_status")

    market = _norm_addr(marketplace)
    want_buyer = _norm_addr(buyer)
    logs = receipt.get("logs") or []
    if not isinstance(logs, list):
        raise PurchaseError("receipt missing logs", code="bad_log")

    matches = []
    for log in logs:
        if not isinstance(log, dict):
            continue
        addr = _norm_addr(str(log.get("address", "")))
        if addr != market:
            continue
        topics = log.get("topics") or []
        if len(topics) < 4:
            continue
        if str(topics[0]).lower() != PURCHASED_TOPIC0:
            continue
        event_tid = _topic_uint(str(topics[1]))
        event_buyer = _topic_address(str(topics[2]))
        event_creator = _topic_address(str(topics[3]))
        if event_tid != int(template_id):
            continue
        if event_buyer != want_buyer:
            raise PurchaseError("buyer mismatch", code="wrong_buyer")
        matches.append(
            {
                "templateId": event_tid,
                "buyer": event_buyer,
                "creator": event_creator,
                "transactionHash": str(log.get("transactionHash") or receipt.get("transactionHash") or ""),
            }
        )

    if not matches:
        # Distinguish wrong contract vs wrong template vs missing event
        any_market = False
        any_purchased = False
        for log in logs:
            if not isinstance(log, dict):
                continue
            try:
                addr = _norm_addr(str(log.get("address", "")))
            except PurchaseError:
                continue
            topics = log.get("topics") or []
            if addr == market:
                any_market = True
                if topics and str(topics[0]).lower() == PURCHASED_TOPIC0:
                    any_purchased = True
                    event_tid = _topic_uint(str(topics[1]))
                    event_buyer = _topic_address(str(topics[2]))
                    if event_buyer != want_buyer:
                        raise PurchaseError("buyer mismatch", code="wrong_buyer")
                    if event_tid != int(template_id):
                        raise PurchaseError("templateId mismatch", code="wrong_template")
            elif topics and str(topics[0]).lower() == PURCHASED_TOPIC0:
                raise PurchaseError("wrong contract", code="wrong_contract")
        if not any_market and not any_purchased:
            raise PurchaseError("Purchased event not found", code="no_event")
        raise PurchaseError("Purchased event not found", code="no_event")

    return matches[0]


async def eth_get_transaction_receipt(
    tx_hash: str,
    *,
    rpc_url: str = MONAD_RPC_DEFAULT,
    fetch_fn: FetchFn | None = None,
) -> dict:
    if fetch_fn is None:
        from workers import fetch as fetch_fn  # type: ignore
    resp = await fetch_fn(
        rpc_url,
        method="POST",
        headers={"Content-Type": "application/json"},
        body=json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": "eth_getTransactionReceipt", "params": [tx_hash]}
        ),
    )
    text = await resp.text()
    try:
        body = json.loads(text)
    except json.JSONDecodeError as e:
        raise PurchaseError("invalid RPC response", code="rpc") from e
    result = body.get("result") if isinstance(body, dict) else None
    if result is None:
        raise PurchaseError("receipt not found", code="no_receipt")
    if not isinstance(result, dict):
        raise PurchaseError("invalid receipt", code="rpc")
    return result


async def verify_purchase_tx(
    *,
    tx_hash: str,
    buyer_wallet: str,
    onchain_template_id: int,
    marketplace: str = MARKETPLACE_DEFAULT,
    rpc_url: str = MONAD_RPC_DEFAULT,
    fetch_fn: FetchFn | None = None,
    receipt: dict | None = None,
) -> dict:
    tx = _norm_tx(tx_hash)
    if receipt is None:
        receipt = await eth_get_transaction_receipt(tx, rpc_url=rpc_url, fetch_fn=fetch_fn)
    matched = parse_purchased_logs(
        receipt,
        marketplace=marketplace,
        buyer=buyer_wallet,
        template_id=onchain_template_id,
    )
    matched["txHash"] = tx
    return matched
