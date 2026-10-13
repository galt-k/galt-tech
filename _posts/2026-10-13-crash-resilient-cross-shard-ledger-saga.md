---
layout: single
title: "Building a Crash-Resilient, Cross-Shard Ledger Saga in Java 21"
seo_title: "Distributed Ledger Saga: Cross-Shard Transfers in Java 21 & PostgreSQL"
excerpt: "A deep dive into building a double-entry ledger that coordinates cross-shard transfers with zero money loss using durable sagas, in-transit clearing accounts, and PostgreSQL fencing tokens."
description: "How to design and implement an asynchronous, crash-resilient distributed ledger Saga in Java 21 and PostgreSQL. Covers double-entry invariants, zero-sum clearing accounts, worker fencing, and concrete database constraints."
date: 2026-10-13
tags:
  - Distributed Systems
  - Java
  - Architecture
  - Database
  - System Design
toc: true
toc_sticky: true
---

<div class="notice--info">
  <strong>Engineering Summary:</strong> When scaling a financial ledger across database shards, global two-phase commit (2PC) is an operational anti-pattern. This post explores how to bifurcate same-shard synchronous execution from durable cross-shard Sagas, conserve value across partitioned databases using in-transit clearing accounts, and enforce at-most-once committed financial effects using PostgreSQL unique constraints and monotonic fencing tokens.
</div>

## Problem

Consider a standard financial transfer: debit Alice $50 and credit Bob $50. In a centralized ledger, this is a routine atomic transaction. Either both balance updates commit within milliseconds, or neither does. Value is strictly conserved.

Once accounts are partitioned across database shards, global database atomicity disappears. If Alice resides on Shard A and Bob on Shard B, no single database engine can enforce both balance updates at once.

If the application crashes, loses network connectivity, or times out immediately after debiting Alice, Bob never receives his funds. Alice's usable balance has decreased, but the offsetting credit has not landed. Without a durable record of intent, the system cannot determine whether to finish the credit, compensate the debit, or safely ignore a client retry. If the client retries the request blindly, Alice risks being debited a second time.

A financial ledger cannot tolerate these failure modes. It operates under strict accounting invariants: every journal entry must be balanced, historical postings are immutable, and value must be conserved across the platform—without silent creation or destruction of funds—even when a transfer is only partially complete.

Reaching for two-phase commit (2PC) or distributed XA transactions across database shards is the wrong default at scale. 2PC holds row locks across network round trips, coupling the availability and latency of independent database engines. A degraded disk, garbage collection pause, or network hiccup on Shard B stalls active transactions on Shard A, rapidly exhausting database connection pools and cascading outages across unrelated accounts.

The architectural challenge is twofold: we must preserve a synchronous, low-latency local ACID path when accounts share a shard, while treating cross-shard movement as a first-class asynchronous pipeline—one that acknowledges work as pending, coordinates multi-database steps durably, and recovers from process crashes and concurrent retries without holding locks across database boundaries.

## Constraints

A viable architecture must satisfy five hard constraints imposed by double-entry accounting, distributed databases, and physical hardware limits:

**Zero-sum conservation under partial execution.** Debits must equal credits within every posted journal entry. If a transfer is interrupted mid-flight, funds cannot vanish into an unrecorded void or appear out of thin air. When funds are debited from the sender on Shard A, they immediately post to an in-transit clearing position on Shard A. Alice's usable balance decreases immediately upon commit, while the public transfer status remains `PENDING` until the destination leg resolves.

**Partitioned concurrency boundaries.** Database transactions are strictly local to a single shard. An operation executed on Shard A cannot hold row locks, reserve database connections, or block execution on Shard B. Every database write must commit independently. Avoiding distributed locks does not mean eliminating local locking; local row-level locks (`SELECT ... FOR UPDATE`) are required within each shard to serialize balance updates.

**Deterministic idempotency under arbitrary crash points.** A process crash, timeout, or network disconnect can occur between any two instructions: after writing to Shard A, before dispatching to Shard B, or while returning a response to the client. Identical client retries must never double-debit an account or produce divergent ledger states.

**Bounded compute and connection capacity.** Database connection pools (such as HikariCP) and thread workers are finite. Synchronous operations cannot block awaiting remote shard confirmations. Latency spikes on one shard must never monopolize connections or cascade failure to healthy shards.

**Bifurcated latency profiles.** The design must respect two distinct operational SLAs. Same-shard transfers belong to a low-latency fast path designed to resolve synchronously in single-digit milliseconds. Cross-shard transfers span independent physical databases and cannot guarantee instantaneous completion, requiring a contractual transition to an asynchronous `PENDING` state.

Together, these constraints rule out distributed 2PC transactions and any expectation of global multi-database atomicity. They force the system into a split architecture: an immediate single-shard transactional path, and an explicit, durable multi-leg coordination path that treats in-transit money as a first-class ledger position.

## The Accounting Model: In-Transit Clearing Positions

To guarantee that value is conserved without holding locks across shards, the system models inter-shard movement through bilateral **in-transit clearing accounts**.

Consider the concrete example: Alice (on Shard A) transfers 50 USD to Bob (on Shard B).

### The Two Local Journals

Instead of an impossible cross-database entry `[Debit Alice, Credit Bob]`, the transfer executes as two separate, balanced local journals:

```
=== Shard A (Source Leg) ===
Debit:   Alice (Customer Account)         $50.00
Credit:  In-Transit Clearing (Shard A)    $50.00
Net Balance: $0.00 (Debits == Credits)

=== Shard B (Destination Leg) ===
Debit:   In-Transit Clearing (Shard B)    $50.00
Credit:  Bob (Customer Account)           $50.00
Net Balance: $0.00 (Debits == Credits)
```

### Invariants Maintained

1. **Local Balance Invariant:** Every single journal entry posted to any database engine satisfies:
   `Total Debits == Total Credits`
   No unbalanced journal is ever permitted to commit. This is enforced by database schema checks and domain validators before insert.

2. **Temporal Clearing Position:** Between time t1 (when Shard A commits) and time t2 (when Shard B commits), the transfer is in-flight. During this window:
   - Alice's usable balance has decreased by $50.00.
   - Shard A's in-transit clearing account reflects a credit balance of $50.00 (a liability: funds held for transfer to Shard B).
   - Bob has not yet received funds.
   - Across the platform, total user balances have temporarily decreased by $50.00, offset exactly by the $50.00 sitting in clearing.

3. **Global Reconciliation Invariant:** Once Shard B commits at t2:
   - Shard B's clearing account reflects a debit balance of $50.00 (an asset: receivable due from Shard A).
   - Across the entire fleet, the inter-shard clearing positions net to zero:
     `Clearing(Shard A) [+$50.00] + Clearing(Shard B) [-$50.00] == $0.00`

4. **Account Balance Non-Negativity:** The database enforces a `CHECK (amount_minor >= 0)` constraint on `account_balance`. If Alice's account has insufficient funds, Shard A's local transaction fails immediately; no funds move and no cross-shard saga is initiated.

## Design

The architecture splits execution into two pathways based on account placement, using a strict single-writer rule: only the ledger service holding affinity for a specific shard may mutate that shard's journals and balances, while a coordinator manages the parent saga lifecycle.

```
                    [ Transfer Request (Idempotency Key) ]
                                      │
                                      ▼
                    [ Resolve Account → Shard Placement ]
                                      │
                                      ▼
                             ◇ Same Shard? ◇
                           /                 \
                  [Yes]  /                     \  [No]
                        /                       \
                       ▼                         ▼
            ┌─────────────────────┐    ┌─────────────────────┐
            │  Single Local ACID  │    │ Persist Parent Saga │
            │       Journal       │    │ plan: accounts,     │
            │ Debit Alice +       │    │ shards, amounts     │
            │ Credit Bob          │    └──────────┬──────────┘
            └──────────┬──────────┘               │
                       │                          ▼
                       ▼               ┌─────────────────────┐
            ┌─────────────────────┐    │   Return PENDING    │
            │ SUCCEEDED / FAILED  │    │    + Transfer ID    │
            │     (Terminal)      │    └──────────┬──────────┘
            └─────────────────────┘               │
                                                  ▼
                                       ┌─────────────────────┐
                                       │ Source Leg (Shard A)│
                                       │ Debit Alice →       │
                                       │ Credit In-Transit   │
                                       └──────────┬──────────┘
                                                  │
                                                  ▼
                                       ┌─────────────────────┐
                                       │  Dest Leg (Shard B) │ ──(Fatal)──► ┌──────────────────────┐
                                       │ Debit In-Transit →  │              │ Compensate Source (A)│
                                       │ Credit Bob          │              │ Debit In-Transit →   │
                                       └──────────┬──────────┘              │ Credit Alice         │
                                                  │ (Success)               └──────────────────────┘
                                                  ▼
                                       ┌─────────────────────┐
                                       │      COMPLETED      │
                                       └─────────────────────┘
```

### 1. Placement-First Routing
When a transfer request arrives, the system resolves the physical shard mapping for both accounts using account metadata before opening database connections. 
- If both accounts reside on the same shard, execution takes the synchronous fast path: a single, local ACID transaction writes the journal (`Debit Alice, Credit Bob`) and updates account balances. It returns a terminal `Completed` response immediately, bypassing saga machinery entirely.
- If accounts map to different shards, execution branches to the durable saga pipeline.

### 2. Durable Asynchronous Acceptance
For cross-shard transfers, the coordinator never begins moving money in-memory before committing intent. The acceptance protocol enforces strict sequencing:
1. The coordinator starts a local transaction on the source shard (or parent coordinator database).
2. It registers the request in `ledger_operation` under the client's `idempotency_key`, recording the immutable plan (account IDs, shards, amounts, currencies, and policy version).
3. In the same transaction, it writes the source leg work item into `ledger_posting_operation_work` with status `READY`.
4. The transaction commits.
5. Only *after* durable commit, the API returns HTTP `202 Accepted` with status `PENDING` and a stable `transfer_id`.

If the coordinator process crashes immediately after this commit, zero funds have moved, but the system has durably captured the intent. A background recovery sweeper will claim the `READY` work row and advance the saga.

### 3. Eager Dispatch vs. Sweeper Recovery
Rather than waiting for a periodic poller to discover new work, the coordinator immediately hands the claimed work item to an in-memory worker pool for eager asynchronous dispatch. The worker routes to Shard A, executes the source leg, and upon success, submits the destination leg.

If the eager thread crashes, runs out of memory, or stalls, the background lease sweeper acts as the safety net: it scans for expired leases and reclaims the row for execution.

## Concurrency, Fencing, and At-Most-Once Execution

A central challenge in distributed execution is worker race conditions caused by network partitions or stop-the-world JVM garbage collection pauses. To guarantee safety, the system distinguishes between four distinct mechanisms:

1. **Lease (`lease_until`):** A coarse-grained time window (e.g., 30 seconds) granting a worker exclusive permission to process a work item. Used solely for liveness and crash detection.
2. **Fencing Token (`claim_generation`):** A monotonically increasing integer incremented on every claim. Used to detect and reject stale worker writes.
3. **Unique Constraints (`UNIQUE(operation_key)`):** Database-enforced uniqueness preventing duplicate financial postings in the journal table.
4. **Row Locks (`FOR UPDATE SKIP LOCKED`):** Concurrency controls ensuring workers do not contend for the same work items during polling.

### Clarifying "Exactly-Once" vs. "At-Most-Once"
In distributed systems, **exactly-once execution does not exist across a network**. Network retries and worker crashes mean that execution is fundamentally **at-least-once**: a worker may execute the code for a leg multiple times.

However, the ledger guarantees **at-most-once committed financial effects per logical step**:
- Every leg is assigned a deterministic step identity:
  - `step_key_source = transfer_id + ":source"`
  - `step_key_dest = transfer_id + ":dest"`
- When a worker appends a journal entry, the write includes `operation_key = step_key`.
- The database schema enforces `CONSTRAINT ledger_journal_operation_unique UNIQUE (operation_key)`.
- If two workers attempt to commit the same step, exactly one transaction commits; the second fails with a unique constraint violation and rolls back completely.

### The Stale-Worker Scenario: Where Does Rejection Occur?

Consider the following concrete failure timeline:

1. **Worker A** claims the source leg work row for `Transfer-101`. It receives fencing token `claim_generation = 7` with a 30-second lease.
2. **Worker A** enters a major 35-second Stop-The-World JVM garbage collection pause before executing the database write.
3. At second 31, the lease expires. The background sweeper runs, claims the expired row, increments the fencing token to `claim_generation = 8`, and dispatches it to **Worker B**.
4. **Worker B** executes against Shard A and commits the journal entry and status update.
5. At second 36, **Worker A** resumes execution, completely unaware that its lease expired. It attempts to complete the step.

**Where is Worker A rejected?**

Worker A is rejected at the database boundary inside `ShardLocalPostingService.postAndComplete()`:

```java
@Transactional
public JournalID postAndComplete(PostingOperation operation, long claimGeneration) {
    // 1. Appends journal to ledger_journal
    journalStore.append(operation.journal());
    
    // 2. Updates work table conditional on the fencing token
    postingOperationWorkStore.complete(operation.operationId(), claimGeneration);
    return operation.journal().journalId();
}
```

The `complete()` method executes:
```sql
UPDATE ledger_posting_operation_work
SET work_status = 'COMPLETED',
    lease_until = NULL,
    updated_at = clock_timestamp()
WHERE posting_operation_id = ?
  AND claim_generation = ?;
```

Because Worker B already updated `claim_generation` to `8`, Worker A's update with generation `7` matches **0 rows**. 

The application detects that 0 rows were updated and immediately throws an `IllegalStateException("Claim generation 7 is stale")`. Because this occurs inside the `@Transactional` boundary, the entire transaction rolls back—including the journal write attempt.

### Crucial Architectural Boundary: Shard Fencing Isolation
It is vital to recognize that **a fencing token on Shard A's work table does NOT protect Shard B**. 

When a worker moves to execute the destination leg on Shard B, Shard B has no visibility into Shard A's `claim_generation`. If a zombie worker mistakenly calls Shard B, the sole protection on Shard B is the database constraint:
```sql
CONSTRAINT ledger_journal_operation_unique UNIQUE (operation_key)
```
Because the destination step key (`transfer_id:dest`) is deterministic, Shard B's database will reject any duplicate destination insertion regardless of worker state.

## Database Correctness Boundaries (PostgreSQL Implementation)

The following representative SQL definitions from the repository illustrate how database constraints enforce these guarantees:

### 1. Work Queue Claiming with Monotonic Fencing
Workers claim available work using `FOR UPDATE SKIP LOCKED`, advancing the monotonic generation token within a single atomic statement:

```sql
WITH candidate AS (
    SELECT posting_operation_id
    FROM ledger_posting_operation_work
    WHERE work_status IN ('READY', 'CLAIMED')
      AND eligible_at <= clock_timestamp()
      AND (lease_until IS NULL OR lease_until <= clock_timestamp())
    ORDER BY eligible_at, created_at, posting_operation_id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE ledger_posting_operation_work work
SET work_status = 'CLAIMED',
    claim_generation = work.claim_generation + 1,
    lease_until = clock_timestamp() + (:lease_ms * INTERVAL '1 millisecond'),
    updated_at = clock_timestamp()
FROM candidate
WHERE work.posting_operation_id = candidate.posting_operation_id
RETURNING work.posting_operation_id, work.claim_generation, work.leg;
```

### 2. Idempotent Journal Writing
Journal entries are bound to the deterministic operation key, guaranteeing at-most-once committed ledger impact:

```sql
CREATE TABLE ledger_journal (
    journal_id       UUID        PRIMARY KEY,
    receipt_id       UUID        NOT NULL UNIQUE,
    operation_key    TEXT        NOT NULL UNIQUE,
    payment_id       UUID        NOT NULL,
    transaction_id   UUID        NOT NULL,
    ledger_book_id   UUID        NOT NULL,
    currency         CHAR(3)     NOT NULL,
    policy_version   TEXT        NOT NULL,
    recorded_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ledger_posting (
    posting_id        UUID        PRIMARY KEY,
    journal_id        UUID        NOT NULL REFERENCES ledger_journal(journal_id),
    ledger_account_id UUID        NOT NULL REFERENCES ledger_account(ledger_account_id),
    amount_minor      BIGINT      NOT NULL CHECK (amount_minor > 0),
    posting_side      VARCHAR(6)  NOT NULL CHECK (posting_side IN ('DEBIT', 'CREDIT'))
);
```

### 3. Account Balance Updates and Row Locking
Within each shard-local transaction, balance mutations are guarded against concurrent race conditions by locking the target account row:

```sql
-- Lock account balance row to serialize concurrent transfers on the same account
SELECT amount_minor, balance_side, account_sequence
FROM account_balance
WHERE ledger_account_id = :account_id
FOR UPDATE;

-- Update balance with sequence check
UPDATE account_balance
SET amount_minor = :new_amount,
    account_sequence = account_sequence + 1
WHERE ledger_account_id = :account_id
  AND account_sequence = :expected_sequence;
```

## The Saga State Machine and Transition Guards

The parent transfer lifecycle follows a strict state machine governed by durable transition guards:

| State | Precondition | Durable Update | Guard / Idempotency Mechanism | Recovery Action |
| :--- | :--- | :--- | :--- | :--- |
| **`ACCEPTED`** | Client command received and validated. | Insert into `ledger_operation` and insert `READY` row in `ledger_posting_operation_work`. | `PRIMARY KEY (idempotency_key)` on operation table. | Sweeper finds expired lease or `READY` status; dispatches source leg. |
| **`IN_TRANSIT`** | Source leg committed on Shard A. | Update parent status to `IN_TRANSIT`; insert destination work row. | Verified source `journal_id` exists on Shard A before transition. | Sweeper verifies source journal on Shard A, then dispatches destination leg. |
| **`COMPLETED`** | Destination leg committed on Shard B. | Update parent status to `COMPLETED`; mark destination work `COMPLETED`. | Verified destination `journal_id` exists on Shard B. | Terminal state. Subsequent client retries return existing completed result. |
| **`COMPENSATING`**| Destination leg permanently rejected (e.g., account closed/frozen). | Update parent status to `COMPENSATING`; insert `SOURCE_COMPENSATION` work row. | Only allowed if source committed AND destination confirmed absent. | Sweeper claims compensation work row; executes mirror journal on Shard A. |
| **`COMPENSATED`** | Mirror journal committed on Shard A (`Debit Clearing, Credit Alice`). | Update parent status to `COMPENSATED`; mark work `COMPLETED`. | `UNIQUE (operation_key)` on compensation journal (`transfer_id:comp`). | Terminal state. Client retries return failure/compensated status. |
| **`UNKNOWN`** | Destination outcome ambiguous (timeout/network reset) after retries. | Parent status flagged `REQUIRES_RECONCILIATION`. | Prevents automated compensation while destination status is unverified. | Triggers automated journal poll or halts for manual operational review. |

## Ambiguous Outcomes, Timeouts, and Safe Compensation

In a distributed saga, the most dangerous scenario is **an unknown outcome caused by a network timeout**:

```
Coordinator  ───────────── POST /dest-leg ────────────►  Shard B
    │                                                      │
    │                                              [Commits Journal]
    │                                                      │
    │  ◄──────────── TCP Timeout / Socket Drop ────────────┘
    ▼
Outcome Unknown!
```

If the coordinator treats this timeout as a failure and immediately triggers compensation on Shard A, it risks creating an invariant violation:
1. Shard B committed the credit to Bob.
2. The coordinator compensates Shard A, returning funds to Alice.
3. **Money has been duplicated out of thin air.**

### The Resolution Protocol
To prevent this failure mode, the system strictly follows a **never-compensate-an-unverified-outcome** rule:

1. **Distinguish Knowledge States:**
   - *Confirmed Committed:* Journal record positively verified on target shard.
   - *Confirmed Uncommitted:* Target shard explicitly returned a terminal rejection (e.g., account frozen, constraint violation) or an authoritative query confirms the deterministic step key does not exist and cannot be committed.
   - *Unknown:* Network timeout, connection reset, or 5xx error.

2. **Authoritative Journal Query:**
   When a destination call times out, the coordinator must not retry blindly or initiate compensation. It must query Shard B's `ledger_journal` table using the deterministic key:
   ```sql
   SELECT journal_id FROM ledger_journal WHERE operation_key = :dest_step_key;
   ```
   - If the journal exists: The operation actually succeeded. The coordinator records success and marks the saga `COMPLETED`.
   - If the journal does not exist: The coordinator may safely retry the write using the identical `operation_key`.

3. **Escalation to Manual Reconciliation:**
   If Shard B remains completely unreachable beyond a configured retry threshold, the saga enters `UNKNOWN / REQUIRES_RECONCILIATION`. Automated compensation is blocked until shard connectivity is restored and authoritative state can be proven.

## Failure-Injection Test Matrix

The following test matrix summarizes the critical failure points, expected system behavior, and corresponding test coverage:

| Failure Scenario | Durable State at Failure | Invariant Preserved | Recovery Mechanism | Test Coverage Status |
| :--- | :--- | :--- | :--- | :--- |
| **Crash before source commit** | Parent saga in `ACCEPTED`; work row in `READY`. | Zero money moved; no unrecorded intent. | Sweeper reclaims `READY` work row and dispatches source leg. | Verified in `PostingSagaCoordinatorTest` |
| **Crash after source commit, before parent update** | Source journal committed on Shard A; parent still shows `ACCEPTED`. | Balance conservation ($50 in Shard A clearing). | Sweeper queries Shard A with `transfer_id:source`, discovers journal, advances parent to `IN_TRANSIT`. | Verified in `RecoveryCoordinatorTest` |
| **Crash after dest commit, before response** | Both journals committed; parent shows `IN_TRANSIT`. | Balance conservation (clearing nets to zero). | Recovery queries Shard B with `transfer_id:dest`, finds journal, marks parent `COMPLETED`. | Verified in `PostingWorkerTest` |
| **Two workers claim same step** | Work row has `claim_generation = N+1`. | Exactly-one committed journal effect. | Database rejects stale worker via fencing check (0 rows updated) or `UNIQUE(operation_key)`. | Verified in `JdbcPostingOperationWorkStoreConcurrencyIntegrationTest` |
| **Stale worker resumes after GC pause** | Work row has newer `claim_generation`. | At-most-once financial update. | Stale worker's `complete()` query updates 0 rows; transaction rolls back. | Verified in `JdbcPostingOperationWorkStoreConcurrencyIntegrationTest` |
| **Client retries with same idempotency key** | Parent saga already exists in database. | Request idempotency; no duplicate plan. | `ledger_operation` primary key conflict returns existing transfer status. | Verified in `PostingSagaCoordinatorTest` |
| **Client retries same key with altered payload** | Existing `ledger_operation` has original parameters. | Payload immutability. | Coordinator validates request against existing row; rejects payload conflict with HTTP 409. | Verified in `StoredOperationResultTest` |
| **Destination fails permanently (e.g. Account Frozen)** | Source committed; destination rejected. | Conservation of funds ($0 net leak). | Coordinator triggers compensation: posts mirror journal on Shard A (`Debit Clearing, Credit Alice`). | Verified in `PostingSagaCoordinatorTest` |
| **Compensation retry after process crash** | Source journal committed; compensation journal committed. | Idempotent compensation. | Re-execution encounters `UNIQUE(operation_key)` on compensation step; treats as complete. | Verified in `TransferLegAccountingConservationTest` |
| **Destination response lost racing with compensation** | Destination committed; coordinator timed out. | No duplicate money creation. | Coordinator queries Shard B before compensating. Finds committed dest leg; cancels compensation. | *Proposed design rule (Requires Shard B query bridge)* |

## Production Notes

In high-throughput deployments, the primary bottlenecks are rarely raw CPU cycles. System saturation stems from database connection pool exhaustion and row-lock contention on hot accounts. Holding transactions open across network boundaries guarantees connection starvation; keeping ledger writes strictly local and short-lived protects shard connection pools.

Teams often delegate saga tracking and retry schedules to dedicated workflow engines like Temporal. While external orchestrators excel at execution history and timers, the ledger service must maintain strict ownership of accounting domain rules: balanced double-entry journals, in-transit clearing positions, and single-writer shard mutations.

Upstream callers must respect the bifurcated contract. Same-shard transfers return immediate, synchronous settlement in single-digit milliseconds. Cross-shard transfers return an accepted acknowledgment with `PENDING`. Upstream callers, such as checkout or payout pipelines, must never treat `PENDING` as final settlement. They must await asynchronous domain events or poll the transfer status before fulfilling orders or releasing external funds.

## Takeaways

1. **Optimize the local path:** When accounts share a database shard, execute a single local ACID journal; never pay distributed coordination costs when you already possess local atomicity.
2. **Conserve value across boundaries:** Never move money between shards without an explicit in-transit clearing position; every individual leg must balance locally at every point in time.
3. **Design for arbitrary crashes:** Eliminate distributed 2PC locks in favor of durable parent intent, deterministic step keys, monotonic fencing tokens, and compensating only legs confirmed to have committed.
