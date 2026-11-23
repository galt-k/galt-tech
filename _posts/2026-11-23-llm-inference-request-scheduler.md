---
layout: single
title: "How do you schedule LLM inference without losing ownership of the work?"
seo_title: "Designing an LLM Inference Request Scheduler in Java 21"
excerpt: "A Java 21 case study in FIFO batching, bounded execution, cancellation races, and the difference between a notification and available capacity."
description: "Designing a Java LLM inference request scheduler through explicit ownership, condition-based waiting, shutdown boundaries, and reproducible concurrency investigations."
date: 2026-11-23
topic: Engineering
tags:
  - Java
  - Concurrency
  - LLM Inference
  - Distributed Systems
  - Performance
toc: true
toc_sticky: true
---

An inference scheduler can form perfectly valid batches and still fail to make progress. It can also report that a batch has finished while leaving its execution capacity permanently occupied. Neither failure requires a complicated algorithm. Both can come from an unclear boundary between selecting work, authorizing execution, and returning resources.

I built a Java 21 scheduler to study those boundaries. The implementation groups FIFO requests into batches, limits outstanding execution attempts, and coordinates cancellation and shutdown. Alongside it, I used small incident simulators to investigate missing notifications and circular lock dependencies.

This article describes the design and the reasoning behind it. The implementation is a learning prototype with incomplete shutdown semantics. Its backend is an abstraction; the performance results below come from a timer-based simulator, not a model server or GPU benchmark.

## Where the scheduler sits

A chat or agent system has several kinds of scheduling. An agent orchestrator decides which model call or tool invocation happens next. A serving layer decides whether a model request can enter the system and when to submit it. An inference engine decides how to execute prefill and decode against finite compute and memory.

This project explores the serving-layer boundary:

```text
Chat / agent orchestrator
        |
        v
Pending model requests
        |
        v
Java request scheduler
  - FIFO batch formation
  - execution reservations
  - cancellation and handoff
        |
        v
Inference backend abstraction
        |
        v
Completion notification
```

For a future connection to a real inference engine, tokenization, KV-cache reuse, continuous batching, and generation can remain inside that engine. A Java batch should not be assumed to correspond to a GPU batch. The backend adapter must make that distinction explicit.

## Two bounds that answer different questions

The exercise uses three configuration values:

| Constraint | Value | Question it answers |
| --- | --- | --- |
| Requests per batch | 8 | How many requests may one submission contain? |
| Estimated token units per batch | 4,096 | How much estimated work may one batch contain? |
| Outstanding execution reservations | 2 | How many attempts may own backend capacity at once? |

The token limit shapes a batch. The slot limit constrains concurrency across batches.

If A and B already own the two execution slots, C must wait even if it contains only one small request. Conversely, a free execution slot does not make an oversized batch valid.

A slot is permission for an attempt to remain outstanding. It is not a particular Java thread. The scheduler thread can submit A, submit B, and then wait while the backend executes both asynchronously. Two slots also do not prove that both batches fit real accelerator memory; that would require a separate capacity model.

These values define a tractable exercise. They are not tuned production recommendations.

## Make ownership explicit before choosing the primitive

The central invariant is simple:

> Every outstanding attempt owns exactly one reservation, and that reservation can be returned at most once.

The implementation represents ownership with a map:

```java
private final Map<Long, AttemptState> activeAttempts = new LinkedHashMap<>();
```

Presence means ownership. Map size is the occupied-slot count. Removing an entry returns capacity.

This avoids maintaining a separate atomic counter that must agree with the map. An atomic increment would protect the integer itself, but not the combined operation of validating identity, checking capacity, and recording ownership.

All those changes use one shared `ReentrantLock`.

Each attempt has one of two states:

```text
                         commit handoff
Absent -> RESERVED --------------------------> HANDING_OFF
             |                                      |
             | abandonment or shutdown              | rejection or confirmed finish
             v                                      v
           Absent                                 Absent
```

`HANDING_OFF` means the scheduler has committed to submission. It continues to represent ownership after the executor accepts. There is no separate running state in this slice.

Attempt identity is distinct from request identity. A retry must receive a fresh attempt ID so a late completion from an earlier attempt cannot release newer ownership. Completed records need not remain forever if IDs are never reused.

## Keep work pending until handoff is secured

Detaching a batch early creates another owner to manage. Suppose the scheduler removes requests, then waits for capacity. If interrupted or shut down, it must now recover work that is no longer in the pending queue.

I chose to retain requests in the queue until capacity and commitment are secured.

Under the shared lock, the scheduler:

1. Checks shutdown and whether requests are pending.
2. Inspects a FIFO prefix without removing it.
3. Checks the batch window and execution capacity.
4. Reserves an attempt and commits handoff.
5. Detaches the selected requests before releasing the lock.

Only then does it call the executor, outside the lock.

The inspection result is a `Candidate`: a request count, token total, and indication that a limit was reached. It is not a `Batch`, does not contain the requests, and does not transfer ownership.

Cancellation remains possible while requests are pending. Once commitment and detachment happen in the protected dispatch transition, queue-level cancellation is too late.

## Waiting invalidates observations

A condition wait releases the lock. That is how producers, cancellation callers, and completion callbacks can make the state useful to the scheduler.

It also means a candidate inspected before waiting may be stale afterward.

One review exercise exposed this sequence:

```text
Scheduler inspects three requests totaling 300 token units.
Both execution slots are occupied; scheduler waits.
A cancellation removes one request.
Completion returns a slot.
Scheduler wakes with an old candidate describing three requests.
```

Reusing that candidate can detach the wrong prefix or fail because fewer requests remain. Refreshing only the count is insufficient: cancellation may also empty the queue or change which batching window applies.

The corrected capacity branch restarts the full decision loop:

```java
if (activeAttempts.size() >= MAX_EXECUTION_SLOTS && !shutdown) {
    changed.await();
    continue;
}
```

This snippet sits inside an outer loop under the shared lock. On wakeup, the scheduler checks shutdown, queue contents, readiness, and capacity again. The outer loop supplies repeated condition checking; this is not a single unchecked wait.

The general rule is stronger than “put waits in loops”: identify every observation invalidated while the lock is released, then recompute the decision from shared state.

## Completion can happen before submission returns

The executor contract allows an accepted batch to finish immediately and invoke its callback inline. Ownership must therefore exist before external submission begins.

The unsafe ordering is:

```text
Submit to executor
Callback runs and finds no ownership
Register ownership
```

Execution has finished, but its newly registered reservation remains stuck.

The chosen ordering is:

```text
Register and commit ownership under lock
Detach batch
Unlock
Submit with completion callback
```

If the callback runs immediately, it finds the committed attempt and removes it. The later `ACCEPTED` return does not register it again or release it a second time.

Release checks state and removes ownership under the same lock. A duplicate callback finds no entry and does nothing. Cleanup uses ordinary lock acquisition so an already-set interruption flag does not prevent the caller from returning resources.

## Shutdown is a decision boundary

A reservation is not yet permission to execute. Shutdown can reclaim an attempt that remains `RESERVED`, but must preserve an attempt already committed as `HANDING_OFF`.

Both operations use the same lock:

| Ordering | Result |
| --- | --- |
| Shutdown wins before commitment | Reservation is removed; dispatch stops |
| Commitment wins before shutdown | Ownership remains; submission may proceed |

This contract permits the physical executor call to begin after shutdown starts if commitment won first. Preventing every executor call from beginning after shutdown would require a different contract.

Cleanup must continue after shutdown. An early review bug checked shutdown inside execution release and refused cleanup. That left finished batches in the active map. Closing admission and completing existing ownership are different transitions.

The full lifecycle remains unfinished. The current request-submission path still admits pending requests after shutdown, and integrated dispatch leaves queued work pending when it stops. Draining, cancelling, or returning that work must be decided before this can be called graceful shutdown. The public shutdown getter also needs a defined cross-thread visibility guarantee.

## Returning an outcome is part of returning ownership

Dispatch reports one of three outcomes:

| Outcome | Responsibility after return |
| --- | --- |
| Accepted | Executor runs the batch and reports completion |
| Rejected | Caller receives the detached batch; execution ownership is released |
| Stopped | No batch is detached; requests remain pending |

The current design does not automatically requeue rejected work. Returning it explicitly avoids losing the batch while leaving retry policy to the caller. Automatic requeue is a possible future policy, but must account for ordering, cancellation handles, and retry storms.

The executor must report ordinary rejection explicitly and guarantee that rejected work will never execute. An unexpected runtime exception or null result is treated as uncertain acceptance. The exception carries the attempt and detached batch; the scheduler does not assume that it is safe to release or retry. A later completion may still arrive.

Likewise, a caller timeout is evidence that waiting ended, not evidence that execution stopped. Reclaiming a slot on that basis can admit a third batch while the original two are still executing.

## Investigating idle capacity with ready work

A separate simulator offered a useful diagnostic exercise: bursts supplied 32 ready batches per second, while two backend timers modeled 40 ms execution per batch. The faulty completion path returned capacity without notifying the waiting scheduler.

The first useful question was not “which primitive is faster?” It was:

> How long does ready work coexist with an available execution slot?

That measurement separates insufficient capacity from a scheduler that is failing to use capacity already available.

| Metric | Before notification fix | Three runs after fix |
| --- | --- | --- |
| Completed batches/sec | 8 | About 32 |
| Backlog at measurement cutoff | 288 | 0 |
| p95 ready-to-start delay | 8,503 ms | 135–136 ms |
| Ready work with free capacity, cumulative | 9,881 ms | 93–115 ms |
| Slot occupancy | 17.69% | 69.88–70.10% |

Each run used a 12-second measurement window and accepted 384 batches. The corrected runs completed all 384 within that window. The faulty run completed 96, leaving 288 queued at cutoff; the harness drained afterward.

These are local simulation observations. They do not measure GPU utilization, TTFT, model quality, or integrated-scheduler performance. Latency samples include only started batches, so backlog must be read alongside percentiles. The simulator also allocates diagnostic strings under its lock, and JVM warmup and host scheduling affect timings.

The evidence supported a notification defect. Thread observations and event order were needed to distinguish that from lock contention or backend saturation.

## A second incident: no progress despite correct-looking methods

The deadlock exercise combined a scheduler and a simulated memory-budget manager. Dispatch acquired the scheduler lock before the memory lock. Completion acquired the memory lock and called back into scheduler cleanup.

```text
Dispatch thread:   owns Scheduler -> waits for Memory
Completion thread: owns Memory    -> waits for Scheduler
```

Each method could appear locally reasonable. The failure was the composition.

Thread diagnostics established the ownership cycle. The structural fix was consistent acquisition order: both paths acquire scheduler state before memory state. Reentrancy permits the completion thread to enter scheduler cleanup again while already owning that lock; it does not resolve a cycle between different threads.

The harness used interruptible lock acquisition to unwind the stalled workers after saving diagnostics. That made the experiment stoppable. It did not prevent the deadlock.

## What has been verified, and what has not

Five shutdown/handoff tests passed, including deterministic orderings and a concurrent start-gate scenario. The concurrent test used two readiness/start latches, futures to propagate worker failures, bounded waits, and executor cleanup. One successful race trial is not proof that every interleaving is correct.

Temporary smoke checks covered accepted dispatch, inline and duplicate completion, definite rejection, and stopped dispatch. The stale-candidate correction compiled, but its cancellation-during-capacity-wait regression remains to be written.

The next verification work is concrete: hold both execution slots, block another dispatch, cancel some or all pending requests, release capacity, and verify that selection is recomputed without losing work or leaking ownership. Lifecycle tests must follow the queued-work shutdown decision.

## The implementation lesson

The hardest translation into Java was deciding which statements must form one protected transition and which observations expire at a wait. The lock, condition, map, callback, and future each solve a different part of that problem.

A useful review starts with four questions: who owns this work, what event transfers responsibility, what evidence permits cleanup, and what can change while this thread is waiting?

For this scheduler, those questions led to a small explicit ownership model. That model is the starting point for correctness; tests and measured behavior determine whether the implementation actually preserves it.

The [Java source and exercises](https://github.com/galt-k/galt-projects/tree/main/java/concurrency-lab) and [engineering design document](https://github.com/galt-k/galt-projects/blob/main/java/concurrency-lab/problem-003-inference-batch-scheduler/design.md) include the current implementation, investigation harnesses, and unresolved decisions.
