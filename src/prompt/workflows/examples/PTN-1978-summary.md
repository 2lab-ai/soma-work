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
| **What** | 암호화폐 입금 시 보너스를 예약하고 자동으로 적용하는 시스템 |
| **Why** | 사용자가 입금 주소 요청 시 보너스를 미리 예약하여 입금 완료 시 자동 지급 |
| **How** | CAS(Compare-And-Swap) 패턴 + FOR UPDATE 락 + 24시간 만료 + Settlement 연동 |
| **Impact** | +1,834 / -25 lines (core logic), 23 files |
| **Quality** | Multi-Agent Review 95.3/100 (GPT-5.2, Gemini-3-Pro, Opus-4.5) |

### Quick Flow
```
User Request → Reserve Bonus → Deposit Detected → Claim+Bind → Deposit Confirmed → Settlement
     │              │                  │                │                │               │
     └─ opBonusNo   └─ wallet.Pending  └─ OnDetected    └─ tx.Claimed    └─ OnConfirmed  └─ UserBonus 생성
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
│                    │ → UserBonus 생성 + 활성화              │               │
│                    └────────────────────────────────────────┘               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Design Principles

#### 1. CAS (Compare-And-Swap) Pattern with Atomic Bind
```csharp
// Single DB transaction으로 bonus claim + tx bind 동시 수행
wallet.PendingBonusNo → tx.ClaimedBonusNo  // 원자적 전환
wallet.PendingBonusNo = null               // 동시에 정리
```

#### 2. Full Idempotency Guarantee
- tx에 이미 `ClaimedBonusNo` 있으면 → 성공 반환 (중복 claim 없음)
- wallet reservation이 이미 정리된 상태에서 retry → 성공 반환
- 동일 bonus 재예약 시 expiry 시간만 반환 (refresh 가능)

#### 3. 24-Hour Expiry with Timestamp Validation
```csharp
private static readonly TimeSpan BonusReservationExpiry = TimeSpan.FromHours(24);

// [P2] PendingBonusRequestedAt null 체크 - 데이터 무결성 문제로 처리
if (!wallet.PendingBonusRequestedAt.HasValue) {
    // Invalid reservation - clear and fail
}
```

#### 4. Defense-in-Depth Validation
| Check | Purpose |
|-------|---------|
| `tx.CryptoWalletNo == cryptoWalletNo` | 소유권 검증 |
| `tx.Type == TransactionType.Deposit` | 타입 검증 (출금 tx에 bonus 바인딩 방지) |
| `now - wallet.PendingBonusRequestedAt <= 24h` | 만료 검증 |
| `wallet.PendingBonusRequestedAt <= tx.CreatedAt` | 새 예약 보호 (idempotent cleanup 시) |
| `string.IsNullOrWhiteSpace(transactionId)` | transactionId 필수화 |

### Key Files & Responsibilities

| File | Role | Lines Changed |
|------|------|---------------|
| `CryptoStoreService.Wallets.cs` | 보너스 예약/클레임/바인드 핵심 로직 | +433 |
| `DepositProcessingModule.cs` | 감지/확인 시 보너스 처리 오케스트레이션 | +189/-16 |
| `UserContext.Impl.Bonus.Impl.Accumulate.cs` | Crypto 입금 보너스 Settlement 연동 | +140 |
| `crypto_deposit_wallet.cs` | Entity 확장 | +11 |
| `crypto_transaction.cs` | Entity 확장 | +11 |

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
| `opBonusNo` | `int` | Optional | 예약할 입금 보너스 번호 (OpBonus.No) |

#### New Response Fields

```json
{
  "Result": 200,
  "Network": "TRC20-nile",
  "Address": "TVx...",
  "AddressQRCodeBase64Png": "...",

  // PTN-1978 New Fields
  "PendingBonusNo": 123,
  "BonusTitle": "첫 입금 10%",
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

**Result**: 새 예약(456) **거부**. 기존 예약(123)이 유효하면 새 보너스로 덮어쓰지 않음.

#### Scenario 4: Same Bonus Re-request
```http
GET /api/CryptoWallet/deposit?opBonusNo=123  # Already reserved
```

**Result**:
- 만료 전: 기존 만료 시간 반환 (재예약 없음)
- 만료 후: 갱신 후 새 만료 시간 반환

### Input Validation

| Input | Behavior |
|-------|----------|
| `opBonusNo=123` (positive) | 정상 처리, 보너스 예약 시도 |
| `opBonusNo=0` | 무시, 보너스 없이 처리 |
| `opBonusNo=-1` (negative) | 무시, 보너스 없이 처리 |
| `opBonusNo=abc` (non-numeric) | **400 Bad Request** |
| `opBonusNo` omitted | 보너스 없이 처리 (기존 동작) |

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
│                        in single DB TX     → Prize 계산 → UserBonus │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Important Considerations

1. **Caching Disabled**: `ResponseCache(NoStore=true)` - 보너스 예약은 부작용이 있으므로 캐싱 안 함
2. **Full Idempotency**: 동일 요청 재시도 시 동일한 결과 보장
3. **Conflict Handling**: 다른 보너스가 이미 예약되어 있고 만료 전이면 새 예약 거부
4. **transactionId 필수화**: bonus claim 시 tx binding 없이 claim만 하면 bonus loss 발생하므로 차단

---

## 3. Code-Level View

### A. Entity Layer

#### `crypto_deposit_wallet.cs` (+11 lines)
```csharp
/// <summary>
/// 대기 중인 입금 보너스 번호 (OpBonus.No)
/// 암호화폐 입금 시 적용할 보너스 - GetDepositAddress 호출 시 설정됨
/// </summary>
public int? PendingBonusNo { get; set; }

/// <summary>
/// 보너스 요청 시간 - 만료 검증용 (기본 24시간)
/// </summary>
public DateTime? PendingBonusRequestedAt { get; set; }
```

#### `crypto_transaction.cs` (+11 lines)
```csharp
/// <summary>
/// 클레임된 입금 보너스 번호 (OpBonus.No)
/// OnDetectedAsync에서 crypto_deposit_wallet.PendingBonusNo를 CAS로 클레임하여 저장
/// </summary>
public int? ClaimedBonusNo { get; set; }

/// <summary>
/// 보너스 처리 완료 여부 - SettlementService.DepositApproval 호출 후 true
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
    // 1. Lock wallet with FOR UPDATE (race condition 방지)
    var wallet = await db.crypto_deposit_wallet
        .FromSqlInterpolated($"SELECT * FROM crypto_deposit_wallet WHERE ... FOR UPDATE")
        .FirstOrDefaultAsync(ct);

    // 2. Check existing reservation
    if (wallet.PendingBonusNo.HasValue) {
        if (wallet.PendingBonusNo == opBonusNo) {
            // Same bonus: 만료됐으면 refresh, 아니면 기존 expiry 반환
        } else {
            // Different bonus: 기존이 만료 전이면 거부
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

    var now = DateTime.UtcNow;  // Lock 획득 후 timestamp 캡처

    // 2. Lock Transaction (FOR UPDATE)
    var lockedTx = await db.crypto_transaction
        .FromSqlInterpolated($"... WHERE TransactionId = {transactionId} FOR UPDATE")
        .FirstOrDefaultAsync(ct);

    // 3. Idempotency: tx에 이미 ClaimedBonusNo 있으면 성공 반환
    if (lockedTx?.ClaimedBonusNo.HasValue == true &&
        lockedTx.CryptoWalletNo == cryptoWalletNo &&
        lockedTx.Type == Deposit) {
        // [P1] 타임스탬프 비교해서 새 예약 보호
        if (wallet.PendingBonusNo == lockedTx.ClaimedBonusNo &&
            wallet.PendingBonusRequestedAt <= lockedTx.CreatedAt) {
            wallet.PendingBonusNo = null;  // 중복 예약 정리
        }
        return Success(lockedTx.ClaimedBonusNo);
    }

    // 4. [P2] Data integrity: PendingBonusRequestedAt null이면 무효 처리
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
    // [P1] transactionId 없이 claim만 하면 bonus loss 발생
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
// 1. Re-fetch fresh row (stale data 방지)
var (_, confirmedFreshRow) = await _store.TryGetByHashAsync(txHash, ct);
var currentRow = confirmedFreshRow ?? row;

// 2. Last-chance bonus binding (이전 시도 실패 시)
if (!currentRow.ClaimedBonusNo.HasValue) {
    await TryClaimAndBindBonusAsync(currentRow.ToAddress, currentRow.TransactionId, ct);
}

// 3. Process bonus via Settlement
if (currentRow.ClaimedBonusNo.HasValue && !currentRow.BonusProcessed) {
    await TryProcessClaimedBonusAsync(currentRow, ct);
}
```

**TryProcessClaimedBonusAsync** - Settlement 연동
```csharp
private async Task TryProcessClaimedBonusAsync(TransactionRow row, CancellationToken ct)
{
    // SettlementService.DepositApproval 호출
    var response = await _settlementFactory.Create().DepositApproval(new() {
        BankTransactionNo = 0,  // Crypto는 bank_transaction 없음
        UserPendingBonusNo = row.ClaimedBonusNo  // OpBonusNo로 해석됨
    });

    if (response.ResultCode == Success || response.ResultCode == NotFound) {
        await _store.MarkBonusProcessedAsync(row.TransactionId, ct);
    }
}
```

### D. Settlement Layer

#### `UserContext.Impl.Bonus.Impl.Accumulate.cs` (+140 lines)

**TryProcessCryptoDepositBonusAsync** - Crypto 전용 보너스 처리
```csharp
/// <summary>
/// PTN-1978: Crypto 입금 보너스 직접 처리 (user_pending_bonus 없이 OpBonusNo로 처리)
/// </summary>
private async Task<ResultCode> TryProcessCryptoDepositBonusAsync(
    BankTransaction bankTransaction, int opBonusNo)
{
    // 1. OpBonus 조회 및 검증
    var opBonus = OpBonusManager.Instance.GetOpBonus(opBonusNo);
    if (opBonus?.DepositBonus == null) return Success;

    // 2. Eligibility 검사
    var eligibilityContext = await BuildDepositEligibilityContextAsync(opBonus, bankTransaction);
    if (!opBonus.DepositBonus.IsEligible(eligibilityContext)) return Success;

    // 3. Prize 계산
    var calculatedPrize = opBonus.CalculateInitialPrize(eligibilityContext);
    if (calculatedPrize <= 0) return Success;

    // 4. 가상 PendingBonus 생성 (DB 저장 없이 메모리에서만)
    var virtualPendingBonus = new UserPendingBonus { Prize = calculatedPrize, ... };

    // 5. UserBonus 생성 및 적용
    await ApplyCryptoDepositBonusAsync(bankTransaction, virtualPendingBonus, opBonus);
}
```

**ApplyCryptoDepositBonusAsync** - UserBonus 생성 (bank_transaction 연결 없이)
```csharp
private async Task<ResultCode> ApplyCryptoDepositBonusAsync(...)
{
    // UserBonus 생성
    await UpsertDepositUserBonusAsync(virtualPendingBonus, bankTransaction, opBonus);

    // bank_transaction 연결은 No > 0인 경우만 (Crypto는 bank_transaction 없음)
    if (bankTransaction.No > 0) {
        await AppendDepositAppliedBonusAsync(...);
    }

    // 보너스 활성화
    await TryActivateDepositUserBonusAsync();
}
```

### E. API Layer

#### `DepositController.cs` (GucciCryptoService) (+29/-1)
```csharp
[HttpGet("address")]
[ResponseCache(NoStore = true)]  // 보너스 예약은 부작용 있으므로 캐싱 비활성화
public async Task<ActionResult<DepositAddressResponse>> GetDepositAddress(
    CryptoAssetType asset,
    int? opBonusNo)  // New parameter
{
    if (opBonusNo.HasValue && opBonusNo.Value > 0) {
        var bonusResult = await _cryptoStore.SetPendingBonusAsync(userNo, network, opBonusNo.Value, ct);
        if (!bonusResult.Success) {
            // [P3] 보너스 예약 실패 시 API 응답에 메시지 포함
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
    int? opBonusNo = null)  // New parameter - GCS로 전달
```

### Database Schema Changes

#### crypto_deposit_wallet
| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `PendingBonusNo` | `int?` | NULL | 예약된 보너스 번호 |
| `PendingBonusRequestedAt` | `datetime(6)?` | NULL | 예약 시각 (만료 검증용) |

#### crypto_transaction
| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `ClaimedBonusNo` | `int?` | NULL | 클레임된 보너스 번호 |
| `BonusProcessed` | `tinyint(1)` | 0 | Settlement 처리 완료 플래그 |

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
| **[P0]** | Transaction ownership validation | tx.CryptoWalletNo 일치 검증 |
| **[P0]** | Same-bonus idempotent fix | 새 예약 보호를 위한 timestamp 비교 |
| **[P1]** | transactionId 필수화 | claim without bind 차단 |
| **[P1]** | Deprecated TryClaimAnyPendingBonusAsync | error: true로 컴파일 타임 차단 |
| **[P2]** | PendingBonusRequestedAt null 처리 | 데이터 무결성 문제로 간주 |
| **[P3]** | API failure notification | 보너스 예약 실패 시 사용자에게 메시지 |

### Key Design Patterns

| Pattern | Implementation |
|---------|----------------|
| CAS (Compare-And-Swap) | `wallet.PendingBonusNo → tx.ClaimedBonusNo` 원자적 전환 |
| Pessimistic Locking | `SELECT ... FOR UPDATE` on wallet + tx |
| Idempotency | tx already has bonus → success, retry-safe |
| Defense-in-Depth | ownership + type + expiry + timestamp 다중 검증 |
| Fresh Row Re-fetch | confirm 전 최신 데이터 재조회 |

### Remaining Work

- [x] ~~Full SettlementService.DepositApproval integration~~ → **Completed**
- [x] ~~TryProcessCryptoDepositBonusAsync 구현~~ → **Completed**

### Known Limitations

1. **bank_transaction 없음**: Crypto 입금은 bank_transaction 레코드가 없으므로 `bankTransaction.No = 0`으로 처리
2. **user_pending_bonus 없음**: Crypto는 OpBonusNo를 직접 사용, 가상 PendingBonus 생성

---

*Generated: 2026-01-08*

