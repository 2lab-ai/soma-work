# Order cancellation API — change summary

Shape reference for the Confluence document. Replace every value with the real
change; keep the section order, the audience split, and the level of detail.

## Overview

| | |
|---|---|
| Change | Cancellation now releases reserved stock synchronously |
| PR | `org/repo#123` |
| Merged | 2026-01-14 |
| Affects | Order API consumers, fulfilment operations |

One paragraph, no jargon: what changed, for whom, and why it was needed. State
the user-visible effect first, the implementation second.

## Part 1 — API consumers

**What changed**

`POST /v1/orders/{id}/cancel` returns `200` only after stock is released. It
used to return `202` and release stock on a background job, so a client that
re-read inventory immediately saw stale numbers.

**Request** — unchanged.

**Response**

```json
{ "orderId": "ord_123", "status": "cancelled", "stockReleased": true }
```

`stockReleased` is new. It is always `true` on a `200`; a partial release now
fails the call with `409` instead of reporting success.

**Migration**

- Clients polling inventory after a cancel can drop the poll.
- Clients treating `202` as success must handle `200`; `202` is no longer returned.
- No change to authentication, rate limits, or error envelope.

## Part 2 — Implementation

**Why**

The background job could lag by minutes under load, and support tickets traced
back to oversold items during that window.

**How**

- `CancelOrderHandler` now calls `StockService.release()` inside the existing
  order transaction, so a release failure rolls the cancellation back.
- The background reconciliation job stays as a safety net; it is now a no-op for
  orders already marked released.

**Risk and rollback**

Cancellation latency rises by roughly the stock-service round trip (~40 ms p95).
Rollback is a straight revert; the reconciliation job still covers correctness.

## Part 3 — Operations

- New metric `order_cancel_stock_release_seconds`; alert above 1 s p95.
- Error budget: `409` rate above 0.5% of cancels means the stock service is
  degraded — page the fulfilment on-call, not the order team.
- No schema migration, no config change, no restart ordering requirement.
