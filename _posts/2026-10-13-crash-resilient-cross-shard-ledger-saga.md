---
layout: single
title: "Building a Crash-Resilient, Cross-Shard Ledger Saga in Java 21"
seo_title: "Distributed Ledger Saga: Cross-Shard Transfers in Java 21 & PostgreSQL"
excerpt: "A deep dive into building a double-entry ledger that coordinates cross-shard transfers with zero money loss using durable sagas, in-transit clearing accounts, and PostgreSQL fencing tokens."
description: "How to design and implement an asynchronous, crash-resilient distributed ledger Saga in Java 21 and PostgreSQL. Covers double-entry invariants, zero-sum clearing accounts, and worker fencing."
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
  <strong>Engineering Summary:</strong> When scaling a financial ledger across database shards, global ACID transactions are an anti-pattern. This post explores how to bifurcate same-shard synchronous execution from durable cross-shard Sagas, mathematically conserve value across partitions with in-transit clearing positions, and prevent duplicate writes from zombie workers using PostgreSQL fencing tokens.
</div>

## Problem

Consider a simple transfer: debit Alice $50 and credit Bob $50. In a centralized ledger, this is a routine atomic transaction. Either both balance updates commit within milliseconds, or neither does. Value is strictly conserved.

Once accounts are partitioned across database shards, global atomicity disappears. If Alice resides on Shard A and Bob on Shard B, no single database engine can enforce both balance updates at once.

If the application crashes, loses connectivity, or times out immediately after debiting Alice, Bob never receives his funds. Alice's money disappears from her usable balance, yet exists nowhere else in the system. If the client retries the request blindly, Alice risks being debited a second time.

A financial ledger cannot tolerate these failure modes. It operates under non-negotiable physical invariants: every entry must be balanced, historical postings are immutable, and the net sum of all money movements across the fleet must equal zero at every instant.

Reaching for two-phase commit (2PC) or distributed transactions across database shards is the wrong default at scale. 2PC holds row locks across network round trips, coupling the availability and latency of independent databases. A degraded disk or network hiccup on Shard B stalls transactions on Shard A, rapidly exhausting connection pools and cascading outages across the platform.

The architectural challenge is twofold: we must preserve a synchronous, sub-5ms local ACID path when accounts share a shard, while treating cross-shard movement as a first-class asynchronous pipeline—one that acknowledges work as pending, coordinates multi-database steps durably, and recovers from process crashes and concurrent retries without holding locks across database boundaries.

## Constraints

A viable architecture must satisfy five hard constraints imposed by double-entry accounting, distributed databases, and physical hardware limits:

**Zero-sum conservation under partial execution.** Debits must equal credits within every posted journal entry. If a transfer is interrupted mid-flight, funds cannot vanish into an unrecorded void or appear out of thin air. When funds are debited from the sender on Shard A, they immediately post to a balanced, in-transit clearing position on Shard A. Alice's usable balance decreases immediately, while the public transfer status remains `PENDING` until the destination leg resolves.

**Partitioned concurrency boundaries.** Database transactions are strictly local to a single shard. An operation executed on Shard A cannot hold row locks, reserve connections, or block execution on Shard B. Every database write must commit independently.

**Deterministic idempotency under arbitrary crash points.** A process crash, timeout, or network disconnect can occur between any two instructions: after writing to Shard A, before dispatching to Shard B, or while returning a response to the client. Identical client retries must never double-debit an account or produce divergent ledger states.

**Bounded compute and connection capacity.** Database connection pools and thread workers are finite. Synchronous operations cannot block awaiting external network hops or remote shard confirmations. Latency spikes on one shard must never monopolize connections or cascade failure to healthy shards.

**Bifurcated latency profiles.** The design must respect two distinct operational SLAs. Same-shard transfers belong to a low-latency fast path that resolves synchronously in single-digit milliseconds. Cross-shard transfers span independent physical boundaries and cannot guarantee instantaneous completion, requiring a contractual transition to an asynchronous `PENDING` state.

Together, these constraints rule out distributed locks, two-phase commit, and any expectation of global atomicity. They force the system into a split architecture: an immediate single-shard transactional path, and an explicit, durable multi-leg coordination path that treats in-transit money as a first-class ledger position.

## Design

The architecture splits execution into two pathways based on account placement, using a strict single-writer rule: only the ledger service holding affinity for a specific shard may mutate that shard's journals and balances, while a coordinator manages the parent saga lifecycle.

**Placement-first routing.** When a transfer request arrives, the system resolves the physical shard mapping for both accounts before touching ledger state. If both accounts reside on the same shard, execution takes the synchronous fast path: a single, local ACID transaction posts the balanced debit and credit directly to the ledger. It returns a terminal success or failure immediately, bypassing saga machinery entirely.

**Durable asynchronous acceptance.** When accounts map to different shards, the system rejects two-phase locking. Instead, the coordinator registers the request under a client-provided idempotency key and durably commits a parent saga record containing the immutable execution plan: account identifiers, shard assignments, amounts, and policy versions. The system immediately returns an Accepted response with a `PENDING` status and a stable transfer identifier, assuming full ownership of driving the transfer to completion.

**Balanced in-transit clearing.** Money never crosses shard boundaries untracked. Each shard maintains an inter-shard clearing account, forming a bilateral balance sheet:
1. **Source leg (Shard A):** Debits the sender and credits Shard A's inter-shard clearing account (a liability: funds owed to Shard B) in a local transaction. The sender's usable balance decreases immediately.
2. **Destination leg (Shard B):** Debits Shard B's inter-shard clearing account (an asset: funds receivable from Shard A) and credits the recipient in a local transaction.

Every transaction is balanced locally ($Debits = Credits$), while the inter-shard clearing positions net to zero across the platform.

**Durable state machine and crash recovery.** The parent saga enforces forward progress through explicit, legal transitions: `ACCEPTED` → `IN_TRANSIT` → `COMPLETED`. Client retries with the same idempotency key safely return the current parent record without re-executing steps. If a coordinator or worker crashes mid-transfer, a background sweeper reconstructs progress directly from durable state and resumes execution. If the destination leg permanently fails, the system executes an idempotent compensation: it posts a new balanced mirror journal on Shard A (debiting clearing and crediting the sender) to return funds to Alice, rather than attempting a distributed database rollback.
