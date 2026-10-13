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
