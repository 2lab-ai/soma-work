# PTN-1978: Crypto Deposit Bonus - Executive Summary

> **PR**: [#583](https://github.com/insightquest-io/Gucci/pull/583)
> **Branch**: `PTN-1978-crypto-deposit-bonus-v2` → `develop`
> **Status**: Open
> **Created**: 2026-01-07
> **Last Updated**: 2026-01-08

---

## Table of Contents

- [TL;DR](#tldr)
- [1. Implementation Developer View](#1-implementation-developer-view)
  - [Architecture Overview](#architecture-overview)
  - [Core Design Principles](#core-design-principles)
  - [Key Files & Responsibilities](#key-files--responsibilities)
- [2. API Consumer View](#2-api-consumer-view)
  - [API Changes](#api-changes)
  - [Usage Scenarios](#usage-scenarios)
  - [Input Validation](#input-validation)
  - [Bonus Lifecycle](#bonus-lifecycle)
- [3. Code-Level View](#3-code-level-view)
  - [Entity Layer](#a-entity-layer)
  - [Store Layer](#b-store-layer)
  - [Processing Layer](#c-processing-layer)
  - [Settlement Layer](#d-settlement-layer)
  - [API Layer](#e-api-layer)
  - [Database Schema](#database-schema-changes)
- [Summary](#summary)

---

## TL;DR

| Item | Description |
|------|-------------|
| **What** | A system that reserves bonuses on cryptocurrency deposits and applies them automatically |
| **Why** | Pre-reserve a bonus when a user requests a deposit address, so it is automatically granted upon deposit completion |
| **How** | CAS (Compare-And-Swap) pattern + FOR UPDATE lock + 24-hour expiry + Settlement integration |
| **Impact** | +1,834 / -25 lines (core logic), 23 files |
| **Quality** | Multi-Agent Review 95.3/100 (GPT-5.2, Gemini-3-Pro, Opus-4.5) |

### Quick Flow
```
User Request → Reserve Bonus → Deposit Detected → Claim+Bind → Deposit Confirmed → Settlement
     │              │                  │                │                │               │
     └─ opBonusNo   └─ wallet.Pending  └─ OnDetected    └─ tx.Claimed    └─ OnConfirmed  └─ UserBonus created
```

---

## 1. Implementation Developer View

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Crypto Deposit Bonus Flow                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  [Phase 1: Reservation]                                                     │
│  ┌──────────────┐    opBonusNo    ┌───────────────────┐                     │
│  │ Client/User  │ ──────────────► │ GetDepositAddress │                     │
│  └──────────────┘                 └─────────┬─────────┘                     │
│                                             │                               │
│                                             ▼                               │
│                        ┌────────────────────────────────────┐               │
│                        │ crypto_deposit_wallet              │               │
│                        │ ├─ PendingBonusNo = opBonusNo      │               │
│                        │ └─ PendingBonusRequestedAt = now   │               │
│                        └────────────────────────────────────┘               │
│                                  (24h expiry)                               │
│                                                                             │
│  [Phase 2: Claim+Bind - OnDetected]                                         │
│  ┌──────────────┐    TxHash     ┌───────────────────┐                       │
│  │ Blockchain   │ ───────────►  │ OnDetectedAsync   │                       │
│  │ (TRON)       │               └─────────┬─────────┘                       │
│  └──────────────┘                         │                                 │
│                                           ▼                                 │
│              ┌─────────────────────────────────────────────────────┐        │
│              │ TryClaimAndBindBonusAtomicAsync (Single DB TX)      │        │
│              │ ┌─────────────────────────────────────────────────┐ │        │
│              │ │ 1. SELECT wallet FOR UPDATE                     │ │        │
│              │ │ 2. SELECT tx FOR UPDATE                         │ │        │
│              │ │ 3. Idempotency: tx.ClaimedBonusNo already set?  │ │        │
│              │ │ 4. Validate: ownership, type, expiry, timestamp │ │        │
│              │ │ 5. CAS: tx.ClaimedBonusNo = wallet.PendingBonus │ │        │
│              │ │ 6. Clear: wallet.PendingBonusNo = null          │ │        │
│              │ │ 7. COMMIT                                       │ │        │
│              │ └─────────────────────────────────────────────────┘ │        │
│              └─────────────────────────────────────────────────────┘        │
│                                                                             │
│  [Phase 3: Process - OnConfirmed]                                           │
│  ┌──────────────┐    6+ confirms  ┌───────────────────┐                     │
│  │ Blockchain   │ ──────────────► │ OnConfirmedAsync  │                     │
│  │ (TRON)       │                 └─────────┬─────────┘                     │
│  └──────────────┘                           │                               │
│                                             ▼                               │
│                    ┌────────────────────────────────────────┐               │
│                    │ TryProcessClaimedBonusAsync            │               │
│                    │ → SettlementService.DepositApproval    │               │
│                    │ → TryProcessCryptoDepositBonusAsync    │               │
│                    │ → UserBonus creation + activation      │               │
│                    └────────────────────────────────────────┘               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Design Principles

#### 1. CAS (Compare-And-Swap) Pattern with Atomic Bind
```csharp
// Performs bonus claim + tx bind atomically in a single DB transaction
wallet.PendingBonusNo → tx.ClaimedBonusNo  // Atomic transfer
wallet.PendingBonusNo = null               // Cleared simultaneously
```

#### 2. Full Idempotency Guarantee
- If `ClaimedBonusNo` already exists on the tx -> return success (no duplicate claim)
- If wallet reservation is already cleared and a retry occurs -> return success
- If the same bonus is re-reserved, only the expiry time is returned (refresh possible)

#### 3. 24-Hour Expiry with Timestamp Validation
```csharp
private static readonly TimeSpan BonusReservationExpiry = TimeSpan.FromHours(24);

// [P2] PendingBonusRequestedAt null check - treated as a data integrity issue
if (!wallet.PendingBonusRequestedAt.HasValue) {
    // Invalid reservation - clear and fail
}
```

#### 4. Defense-in-Depth Validation
| Check | Purpose |
|-------|---------|
| `tx.CryptoWalletNo == cryptoWalletNo` | Ownership verification |
| `tx.Type == TransactionType.Deposit` | Type verification (prevent bonus binding to withdrawal tx) |
| `now - wallet.PendingBonusRequestedAt <= 24h` | Expiry verification |
| `wallet.PendingBonusRequestedAt <= tx.CreatedAt` | New reservation protection (during idempotent cleanup) |
| `string.IsNullOrWhiteSpace(transactionId)` | Enforce required transactionId |

### Key Files & Responsibilities

| File | Role | Lines Changed |
|------|------|---------------|
| `CryptoStoreService.Wallets.cs` | Core logic for bonus reservation/claim/bind | +433 |
| `DepositProcessingModule.cs` | Orchestration for bonus processing on detect/confirm | +189/-16 |
| `UserContext.Impl.Bonus.Impl.Accumulate.cs` | Crypto deposit bonus Settlement integration | +140 |
| `crypto_deposit_wallet.cs` | Entity extension | +11 |
| `crypto_transaction.cs` | Entity extension | +11 |

---

## 2. API Consumer View

### API Changes

#### Affected Endpoints

| Service | Endpoint |
|---------|----------|
| GucciCryptoService | `GET /api/crypto/v1/deposit/address` |
| GucciService | `GET /api/CryptoWallet/deposit` |

#### New Request Parameter

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `opBonusNo` | `int` | Optional | Deposit bonus number to reserve (OpBonus.No) |

#### New Response Fields

```json
{
  "Result": 200,
  "Network": "TRC20-nile",
  "Address": "TVx...",
  "AddressQRCodeBase64Png": "...",

  // PTN-1978 New Fields
  "PendingBonusNo": 123,
  "BonusTitle": "First Deposit 10%",
  "BonusExpiresAt": "2026-01-08T15:00:00Z",

  // Existing Fields (PTN-1969)
  "DepositDailyLimitUSDT": 10000,
  "DepositUsedTodayUSDT": 500,
  "DepositRemainingUSDT": 9500,
  "DailyLimitResetAtUTC": "2026-01-08T00:00:00Z"
}
```

### Usage Scenarios

#### Scenario 1: Request with Bonus
```http
GET /api/CryptoWallet/deposit?network=TRC20&opBonusNo=123
Authorization: Bearer <token>
```

**Response (200)**:
```json
{
  "Result": 200,
  "Address": "TVx...",
  "PendingBonusNo": 123,
  "BonusExpiresAt": "2026-01-08T15:00:00Z"
}
```

#### Scenario 2: Request without Bonus (Existing Behavior)
```http
GET /api/CryptoWallet/deposit?network=TRC20
```

**Response**: `PendingBonusNo`, `BonusTitle`, `BonusExpiresAt` are all `null`

#### Scenario 3: Bonus Conflict (Different Bonus)
```http
GET /api/CryptoWallet/deposit?opBonusNo=456  # Existing: 123 reserved, not expired
```

**Result**: New reservation (456) **rejected**. If the existing reservation (123) is still valid, it will not be overwritten with a new bonus.

#### Scenario 4: Same Bonus Re-request
```http
GET /api/CryptoWallet/deposit?opBonusNo=123  # Already reserved
```

**Result**:
- Before expiry: Returns the existing expiry time (no re-reservation)
- After expiry: Refreshes and returns a new expiry time

### Input Validation

| Input | Behavior |
|-------|----------|
| `opBonusNo=123` (positive) | Normal processing, bonus reservation attempted |
| `opBonusNo=0` | Ignored, processed without bonus |
| `opBonusNo=-1` (negative) | Ignored, processed without bonus |
| `opBonusNo=abc` (non-numeric) | **400 Bad Request** |
| `opBonusNo` omitted | Processed without bonus (existing behavior) |

### Bonus Lifecycle

```
┌────────────────────────────────────────────────────────────────────┐
│                       Bonus Lifecycle                              │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  [1. Reserved]        [2. Claimed+Bound]   [3. Processed]          │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐           │
│  │ Wallet      │     │ Transaction │     │ Settlement  │           │
│  │ .Pending    │────►│ .Claimed    │────►│ .UserBonus  │           │
│  │  BonusNo    │     │  BonusNo    │     │  Created    │           │
│  └─────────────┘     └─────────────┘     └─────────────┘           │
│        │                   │                   │                   │
│        │ (24h expiry)      │ (on detect)       │ (on confirm)      │
│        ▼                   ▼                   ▼                   │
│    Auto Expire         Atomic Claim+Bind   DepositApproval API     │
│                        in single DB TX     → Prize calculation → UserBonus │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Important Considerations

1. **Caching Disabled**: `ResponseCache(NoStore=true)` - Bonus reservation has side effects, so caching is disabled
2. **Full Idempotency**: Guaranteed identical results on identical request retries
3. **Conflict Handling**: If a different bonus is already reserved and not expired, the new reservation is rejected
4. **Required transactionId**: Claiming a bonus without tx binding would cause bonus loss, so it is blocked

---

## 3. Code-Level View

### A. Entity Layer

#### `crypto_deposit_wallet.cs` (+11 lines)
```csharp
/// <summary>
/// Pending deposit bonus number (OpBonus.No)
/// Bonus to apply on cryptocurrency deposit - set during GetDepositAddress call
/// </summary>
public int? PendingBonusNo { get; set; }

/// <summary>
/// Bonus request timestamp - for expiry validation (default 24 hours)
/// </summary>
public DateTime? PendingBonusRequestedAt { get; set; }
```

#### `crypto_transaction.cs` (+11 lines)
```csharp
/// <summary>
/// Claimed deposit bonus number (OpBonus.No)
/// Stored by CAS-claiming crypto_deposit_wallet.PendingBonusNo in OnDetectedAsync
/// </summary>
public int? ClaimedBonusNo { get; set; }

/// <summary>
/// Whether bonus processing is complete - set to true after SettlementService.DepositApproval call
/// </summary>
public bool BonusProcessed { get; set; } = false;
```

### B. Store Layer

#### `CryptoStoreService.Wallets.cs` (+433 lines)

**1. SetPendingBonusAsync** - Bonus Reservation
```csharp
public async Task<SetPendingBonusResult> SetPendingBonusAsync(
    int userNo, CryptoNetworkType network, int opBonusNo, CancellationToken ct)
{
    // 1. Lock wallet with FOR UPDATE (prevent race conditions)
    var wallet = await db.crypto_deposit_wallet
        .FromSqlInterpolated($"SELECT * FROM crypto_deposit_wallet WHERE ... FOR UPDATE")
        .FirstOrDefaultAsync(ct);

    // 2. Check existing reservation
    if (wallet.PendingBonusNo.HasValue) {
        if (wallet.PendingBonusNo == opBonusNo) {
            // Same bonus: refresh if expired, otherwise return existing expiry
        } else {
            // Different bonus: reject if existing reservation has not expired
        }
    }

    // 3. New reservation
    wallet.PendingBonusNo = opBonusNo;
    wallet.PendingBonusRequestedAt = now;
}
```

**2. TryClaimAndBindBonusAtomicAsync** - Atomic Claim+Bind (Core!)
```csharp
public async Task<ClaimBonusResult> TryClaimAndBindBonusAtomicAsync(
    int cryptoWalletNo, string? transactionId, CancellationToken ct)
{
    await using var dbTx = await db.Database.BeginTransactionAsync(ct);

    // 1. Lock Wallet (FOR UPDATE)
    var wallet = await db.crypto_deposit_wallet
        .FromSqlInterpolated($"... WHERE No = {cryptoWalletNo} FOR UPDATE")
        .FirstOrDefaultAsync(ct);

    var now = DateTime.UtcNow;  // Capture timestamp after acquiring lock

    // 2. Lock Transaction (FOR UPDATE)
    var lockedTx = await db.crypto_transaction
        .FromSqlInterpolated($"... WHERE TransactionId = {transactionId} FOR UPDATE")
        .FirstOrDefaultAsync(ct);

    // 3. Idempotency: if tx already has ClaimedBonusNo, return success
    if (lockedTx?.ClaimedBonusNo.HasValue == true &&
        lockedTx.CryptoWalletNo == cryptoWalletNo &&
        lockedTx.Type == Deposit) {
        // [P1] Compare timestamps to protect new reservations
        if (wallet.PendingBonusNo == lockedTx.ClaimedBonusNo &&
            wallet.PendingBonusRequestedAt <= lockedTx.CreatedAt) {
            wallet.PendingBonusNo = null;  // Clean up duplicate reservation
        }
        return Success(lockedTx.ClaimedBonusNo);
    }

    // 4. [P2] Data integrity: treat as invalid if PendingBonusRequestedAt is null
    if (!wallet.PendingBonusRequestedAt.HasValue) {
        // Clear invalid reservation
        return Fail;
    }

    // 5. Validation
    if (string.IsNullOrWhiteSpace(transactionId)) return Fail("no_tx");
    if (tx.CryptoWalletNo != cryptoWalletNo) return Fail("ownership");
    if (tx.Type != Deposit) return Fail("type");
    if (expired(wallet.PendingBonusRequestedAt)) return Fail("expired");

    // 6. CAS: Transfer Wallet → Transaction
    tx.ClaimedBonusNo = wallet.PendingBonusNo;
    tx.BonusProcessed = false;
    wallet.PendingBonusNo = null;
    wallet.PendingBonusRequestedAt = null;

    await dbTx.CommitAsync(ct);
}
```

**3. TryClaimAnyPendingBonusAsync** - DEPRECATED
```csharp
[Obsolete("Use TryClaimAndBindBonusAtomicAsync with transactionId instead", error: true)]
public Task<ClaimBonusResult> TryClaimAnyPendingBonusAsync(...)
{
    // [P1] Claiming without transactionId causes bonus loss
    throw new NotSupportedException(...);
}
```

### C. Processing Layer

#### `DepositProcessingModule.cs` (+189/-16 lines)

**OnDetectedAsync Changes**
```csharp
// After creating deposit transaction:
await TryClaimAndBindBonusAsync(to, transactionId, ct);

// Retry logic for existing tx without bonus:
if (!row.ClaimedBonusNo.HasValue && !string.IsNullOrWhiteSpace(effectiveAddress)) {
    await TryClaimAndBindBonusAsync(effectiveAddress, row.TransactionId, ct);
}
```

**OnConfirmedAsync Changes**
```csharp
// 1. Re-fetch fresh row (prevent stale data)
var (_, confirmedFreshRow) = await _store.TryGetByHashAsync(txHash, ct);
var currentRow = confirmedFreshRow ?? row;

// 2. Last-chance bonus binding (if previous attempts failed)
if (!currentRow.ClaimedBonusNo.HasValue) {
    await TryClaimAndBindBonusAsync(currentRow.ToAddress, currentRow.TransactionId, ct);
}

// 3. Process bonus via Settlement
if (currentRow.ClaimedBonusNo.HasValue && !currentRow.BonusProcessed) {
    await TryProcessClaimedBonusAsync(currentRow, ct);
}
```

**TryProcessClaimedBonusAsync** - Settlement Integration
```csharp
private async Task TryProcessClaimedBonusAsync(TransactionRow row, CancellationToken ct)
{
    // Call SettlementService.DepositApproval
    var response = await _settlementFactory.Create().DepositApproval(new() {
        BankTransactionNo = 0,  // Crypto has no bank_transaction
        UserPendingBonusNo = row.ClaimedBonusNo  // Interpreted as OpBonusNo
    });

    if (response.ResultCode == Success || response.ResultCode == NotFound) {
        await _store.MarkBonusProcessedAsync(row.TransactionId, ct);
    }
}
```

### D. Settlement Layer

#### `UserContext.Impl.Bonus.Impl.Accumulate.cs` (+140 lines)

**TryProcessCryptoDepositBonusAsync** - Crypto-Specific Bonus Processing
```csharp
/// <summary>
/// PTN-1978: Direct crypto deposit bonus processing (processes via OpBonusNo without user_pending_bonus)
/// </summary>
private async Task<ResultCode> TryProcessCryptoDepositBonusAsync(
    BankTransaction bankTransaction, int opBonusNo)
{
    // 1. Look up and validate OpBonus
    var opBonus = OpBonusManager.Instance.GetOpBonus(opBonusNo);
    if (opBonus?.DepositBonus == null) return Success;

    // 2. Eligibility check
    var eligibilityContext = await BuildDepositEligibilityContextAsync(opBonus, bankTransaction);
    if (!opBonus.DepositBonus.IsEligible(eligibilityContext)) return Success;

    // 3. Prize calculation
    var calculatedPrize = opBonus.CalculateInitialPrize(eligibilityContext);
    if (calculatedPrize <= 0) return Success;

    // 4. Create virtual PendingBonus (in-memory only, no DB persistence)
    var virtualPendingBonus = new UserPendingBonus { Prize = calculatedPrize, ... };

    // 5. Create and apply UserBonus
    await ApplyCryptoDepositBonusAsync(bankTransaction, virtualPendingBonus, opBonus);
}
```

**ApplyCryptoDepositBonusAsync** - UserBonus Creation (Without bank_transaction Link)
```csharp
private async Task<ResultCode> ApplyCryptoDepositBonusAsync(...)
{
    // Create UserBonus
    await UpsertDepositUserBonusAsync(virtualPendingBonus, bankTransaction, opBonus);

    // Only link bank_transaction if No > 0 (Crypto has no bank_transaction)
    if (bankTransaction.No > 0) {
        await AppendDepositAppliedBonusAsync(...);
    }

    // Activate bonus
    await TryActivateDepositUserBonusAsync();
}
```

### E. API Layer

#### `DepositController.cs` (GucciCryptoService) (+29/-1)
```csharp
[HttpGet("address")]
[ResponseCache(NoStore = true)]  // Disable caching since bonus reservation has side effects
public async Task<ActionResult<DepositAddressResponse>> GetDepositAddress(
    CryptoAssetType asset,
    int? opBonusNo)  // New parameter
{
    if (opBonusNo.HasValue && opBonusNo.Value > 0) {
        var bonusResult = await _cryptoStore.SetPendingBonusAsync(userNo, network, opBonusNo.Value, ct);
        if (!bonusResult.Success) {
            // [P3] Include message in API response on bonus reservation failure
            response.Message = "Bonus reservation failed. Another bonus may be pending.";
        }
    }
}
```

#### `CryptoWalletController.cs` (GucciService) (+14/-3)
```csharp
[ResponseCache(NoStore = true)]
[HttpGet("deposit")]
public async Task GetDepositAddress(
    string network = "TRC20",
    string asset = "USDT",
    int? opBonusNo = null)  // New parameter - forwarded to GCS
```

### Database Schema Changes

#### crypto_deposit_wallet
| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `PendingBonusNo` | `int?` | NULL | Reserved bonus number |
| `PendingBonusRequestedAt` | `datetime(6)?` | NULL | Reservation timestamp (for expiry validation) |

#### crypto_transaction
| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `ClaimedBonusNo` | `int?` | NULL | Claimed bonus number |
| `BonusProcessed` | `tinyint(1)` | 0 | Settlement processing complete flag |

---

## Summary

### Change Statistics

| Layer | Files | Additions | Deletions |
|-------|-------|-----------|-----------|
| Entity | 2 | 22 | 0 |
| Store | 3 | 476 | 2 |
| Processing | 1 | 189 | 16 |
| Settlement | 1 | 140 | 0 |
| API/Controller | 3 | 51 | 4 |
| Contract/DTO | 2 | 12 | 0 |
| Migration | 3 | 10,833 | 0 |
| Swagger | 2 | 110 | 2 |
| **Total** | **23** | **12,707** | **27** |

### Quality Metrics

| Metric | Value |
|--------|-------|
| Multi-Agent Review Score | 95.3/100 |
| Review Rounds | 9 |
| Improvements Applied | 19+ fixes |

### Key Improvements Applied (Round 1→2)

| Priority | Fix | Description |
|----------|-----|-------------|
| **[P0]** | Transaction ownership validation | Verify tx.CryptoWalletNo match |
| **[P0]** | Same-bonus idempotent fix | Timestamp comparison to protect new reservations |
| **[P1]** | Enforce required transactionId | Block claim without bind |
| **[P1]** | Deprecated TryClaimAnyPendingBonusAsync | Compile-time block with error: true |
| **[P2]** | PendingBonusRequestedAt null handling | Treated as data integrity issue |
| **[P3]** | API failure notification | Message to user on bonus reservation failure |

### Key Design Patterns

| Pattern | Implementation |
|---------|----------------|
| CAS (Compare-And-Swap) | Atomic transfer `wallet.PendingBonusNo → tx.ClaimedBonusNo` |
| Pessimistic Locking | `SELECT ... FOR UPDATE` on wallet + tx |
| Idempotency | tx already has bonus → success, retry-safe |
| Defense-in-Depth | Multiple validations: ownership + type + expiry + timestamp |
| Fresh Row Re-fetch | Re-query latest data before confirm |

### Remaining Work

- [x] ~~Full SettlementService.DepositApproval integration~~ → **Completed**
- [x] ~~TryProcessCryptoDepositBonusAsync implementation~~ → **Completed**

### Known Limitations

1. **No bank_transaction**: Crypto deposits have no bank_transaction record, so `bankTransaction.No = 0` is used
2. **No user_pending_bonus**: Crypto uses OpBonusNo directly, creating a virtual PendingBonus

---

*Generated: 2026-01-08*
