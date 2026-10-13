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

### Execution Flow & Money Movement

The following diagram illustrates the routing and money movement across shard boundaries:

<div class="mermaid-wrapper">
<pre class="mermaid">
flowchart TD
    %% Intake
    REQ["Transfer Request (Idempotency Key)"]
    RESOLVE["Resolve Shard Placement"]
    BRANCH{"Same Shard?"}

    REQ --> RESOLVE
    RESOLVE --> BRANCH

    %% Fast Path
    subgraph FAST_LANE ["Fast Path (Same Shard)"]
        FAST["Single Local ACID Journal<br/><b>Debit Alice + Credit Bob</b>"]
        TERM(["SUCCEEDED / FAILED<br/><i>(Terminal)</i>"])
        FAST --> TERM
    end

    %% Cross Shard Saga Path
    subgraph SAGA_LANE ["Durable Saga Path (Cross-Shard)"]
        PARENT["Persist Parent Saga<br/><i>plan: accounts, shards, amounts</i>"]
        ACK["Return PENDING + Transfer ID"]
        SRC["Source Leg (Shard A)<br/><b>Debit Alice → Credit In-Transit</b>"]
        DEST["Dest Leg (Shard B)<br/><b>Debit In-Transit → Credit Bob</b>"]
        DONE(["COMPLETED"])
        COMP["Compensate Source Leg (Shard A)<br/><b>Debit In-Transit → Credit Alice</b>"]

        PARENT --> ACK
        ACK --> SRC
        SRC --> DEST
        DEST -- "Success" --> DONE
        DEST -- "Fatal Failure" --> COMP
    end

    BRANCH -- "Yes" --> FAST
    BRANCH -- "No" --> PARENT

    %% Styling
    classDef intake fill:#f8f9fa,stroke:#495057,stroke-width:2px,color:#212529;
    classDef fast fill:#ebfbee,stroke:#2b8a3e,stroke-width:2px,color:#2b8a3e;
    classDef saga fill:#e7f5ff,stroke:#1971c2,stroke-width:2px,color:#1971c2;
    classDef fail fill:#ffe3e3,stroke:#c92a2a,stroke-width:2px,color:#c92a2a;

    class REQ,RESOLVE,BRANCH intake;
    class FAST,TERM fast;
    class PARENT,ACK,SRC,DEST,DONE saga;
    class COMP fail;
</pre>
</div>

> *Same-shard commits in one local transaction; cross-shard uses two local legs plus a durable parent, with value held in in-transit between legs.*

<style>
  .mermaid-wrapper {
    width: 100%;
    margin: 2rem 0;
    text-align: center;
    background: #ffffff;
    padding: 1.5rem 1rem;
    border-radius: 8px;
    border: 1px solid #e9ecef;
    box-shadow: 0 2px 4px rgba(0,0,0,0.04);
  }
  .mermaid-wrapper svg {
    max-width: 100% !important;
    height: auto !important;
    font-size: 15px !important;
  }
</style>

<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ 
    startOnLoad: true, 
    theme: 'neutral',
    flowchart: {
      useMaxWidth: true,
      htmlLabels: true,
      curve: 'basis'
    }
  });
</script>

## Failure modes

A distributed ledger cannot assume clean execution. It must maintain financial invariants across six distinct failure scenarios:

**Crash before any leg commits.** If the host crashes immediately after accepting the transfer, no funds have moved. The background sweeper detects an expired lease on the `ACCEPTED` parent saga, claims it with a new lease token, and launches the source leg. *Invariant preserved:* Zero unrecorded intent; no money lost or orphaned.

**Crash after source leg commits.** A process dies after committing the source journal on Shard A, but before updating the parent record. Funds sit legally in Shard A's in-transit account. Upon recovery, the sweeper queries Shard A using the deterministic step key (`transfer_id:source`). Finding the committed journal, it safely advances the parent state to `IN_TRANSIT` and dispatches the destination leg. *Invariant preserved:* Balance conservation; value remains locked in clearing rather than stranded.

**Two workers claim the same step.** Network partitions or GC pauses can lead two workers to execute the same leg concurrently. Monotonic fencing tokens reject stale parent updates, while unique database constraints on the shard journal (`UNIQUE(step_key)`) ensure only one transaction commits; the duplicate fails on conflict. *Invariant preserved:* Exactly-once execution; zero duplicate debits or credits.

**Unknown outcome after timeout.** A network call to Shard B times out mid-flight. The coordinator treats the outcome as unknown. It never guesses or triggers compensation prematurely. Instead, it queries Shard B's journal for the destination step key. If found, it marks completion; if absent, it safely retries. *Invariant preserved:* State determinism; never compensate a phantom leg or duplicate credits.

**Destination leg fails permanently.** If Bob's account is closed or frozen, Shard B returns a non-retryable rejection. The coordinator initiates compensation only for confirmed committed legs. It posts an idempotent mirror journal on Shard A (debit in-transit, credit Alice). *Invariant preserved:* Conservation of funds; Alice's usable balance is restored, and clearing nets to zero.

**Client retries while PENDING.** If a client re-submits the request under network jitter, the gateway resolves the idempotency key to the existing parent record and returns the current `PENDING` status. No second execution plan is generated. *Invariant preserved:* Request idempotency.

These failure modes are why durable parent state, deterministic step identities, and a strict rule to compensate only what is confirmed committed are non-negotiable requirements in financial systems.
