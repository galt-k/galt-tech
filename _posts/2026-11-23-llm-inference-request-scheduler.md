---
layout: single
title: "How do you schedule LLM inference without losing ownership of the work?"
seo_title: "Execution Ownership in a Java LLM Inference Request Scheduler"
excerpt: "How explicit ownership prevents premature capacity release across caller timeouts, asynchronous completion, cancellation, and shutdown."
description: "A Java 21 engineering exercise in execution-slot ownership: state transitions, completion callbacks, shutdown boundaries, caller-timeout tests, and implementation tradeoffs."
date: 2026-11-23
topic: Engineering
tags:
  - Java
  - Concurrency
  - LLM Inference
  - System Design
toc: true
toc_sticky: true
---

## The problem: when is execution capacity really free?

Build a Java request scheduler that forms batches for an inference backend and permits at most two outstanding execution attempts. It must preserve that bound when callers stop waiting, completion callbacks arrive early or twice, and shutdown races with submission. It must also keep responsibility for requests clear as they move from the pending queue to the backend.

Consider the failure we want to avoid:

```text
A and B are executing. Both slots are occupied.
A's caller times out.
The serving layer returns A's slot and admits C.
A has not stopped: A, B, and C may now execute concurrently.
```

The slot counter can say “two” while three batches are running. The error is the event that returned capacity: the caller stopped waiting, but execution did not necessarily stop.

The design rule is:

> Release execution capacity only after definite rejection, execution completion, or confirmation that execution stopped. A caller timeout alone is insufficient.

I built a Java 21 learning prototype to explore that rule. It has FIFO batching, execution reservations, and an explicit handoff boundary. It is not a production inference service: the backend is an interface, caller deadlines and backend cancellation are not implemented, and queued-work shutdown policy remains unfinished. A separate fake-backend test verifies that timing out a caller-side wait leaves execution ownership intact.

**Code and design:** [Java implementation](https://github.com/galt-k/galt-projects/blob/main/java/concurrency-lab/problem-003-inference-batch-scheduler/src/main/java/dev/concurrencylab/batching/BatchScheduler.java) · [Design document](https://github.com/galt-k/galt-projects/blob/main/java/concurrency-lab/problem-003-inference-batch-scheduler/design.md) · [Caller-timeout test](https://github.com/galt-k/galt-projects/blob/main/java/concurrency-lab/problem-003-inference-batch-scheduler/src/test/java/dev/concurrencylab/batching/CallerTimeoutTest.java)

## Scope: the serving layer, not the inference engine

A chat or agent orchestrator may make several model calls for one customer turn. This scheduler coordinates those requests before passing work to an execution backend.

```text
Chat / agent orchestrator
          |
          v
Pending requests -> Java scheduler -> Backend abstraction
                          ^                   |
                          |                   v
                    Return capacity <- Completion callback
```

A future backend adapter may delegate tokenization, KV-cache reuse, continuous batching, and generation to an inference engine. A Java batch must not be assumed to equal a GPU batch.

The exercise has two kinds of limits:

| Limit | Configuration | Purpose |
| --- | --- | --- |
| Batch size | At most 8 requests and 4,096 estimated token units | Bound the work grouped into one submission |
| Execution capacity | At most 2 owned slots | Bound outstanding attempts across batches |

A slot is not a dedicated Java thread. The scheduler can submit A and B asynchronously and wait for capacity before submitting more work. Two slots also do not establish a real accelerator-memory bound. The values are exercise settings, not production tuning recommendations.

## Represent responsibility as ownership

The design separates responsibility for requests from ownership of execution capacity.

| Stage | Responsibility for the work | Execution capacity |
| --- | --- | --- |
| Pending | Queue retains requests; cancellation can remove them | None |
| Reserved | Requests remain pending | Attempt owns a slot |
| Committed and detached | Dispatch operation must submit or report its outcome | Slot remains owned |
| Accepted | Executor must execute and report completion | Slot remains owned until confirmed finish |
| Definitely rejected | Caller receives detached batch for disposition | Slot is returned |

There are two attempt states:

```text
Absent -> RESERVED -> HANDING_OFF
             |              |
             | abandon      | rejection, completion,
             | or shutdown  | or confirmed stopping
             v              v
           Absent         Absent
```

`HANDING_OFF` means committed to submission. The state continues to represent an accepted, unfinished execution; it does not prove that execution has started.

The active map is the source of truth:

```java
private final LinkedHashMap<Long, AttemptState> activeAttempts =
        new LinkedHashMap<>();
```

Each entry owns one slot. Its size is the occupied-slot count. State validation and removal use the same shared `ReentrantLock` as reservation and commitment.

An attempt ID identifies one execution attempt, not a customer or request. Retries require fresh identities. Otherwise, a late completion for an old execution could release a newer reservation. IDs must never be reused; the integrated path allocates a monotonic negative range and rejects exhaustion.

## Commit before detaching, register before submitting

Removing a batch before capacity is available creates another ownership problem: an interruption can leave requests outside the queue without a backend responsible for them.

The chosen flow keeps requests pending until the dispatch decision is secured. Under the shared lock, the scheduler:

1. Checks shutdown and pending work.
2. Inspects a FIFO batch candidate and its forming window.
3. Checks execution capacity.
4. Registers a `RESERVED` attempt and commits it to `HANDING_OFF`.
5. Detaches the selected requests before releasing the lock.

It then calls external executor code outside the lock.

The five-millisecond batching window is a readiness threshold, not a latency guarantee. Hitting a request/token limit, encountering a next FIFO request that cannot fit, or reaching window expiry makes a batch eligible. Capacity can still delay it.

The ordering also handles immediate completion. The executor may invoke its completion callback before its submission method returns:

```text
Register ownership -> commit -> detach -> unlock -> submit
                                                    |
                                             inline completion
                                                    |
                                             remove ownership
                                                    |
                                             return ACCEPTED
```

The accepted return must not recreate the entry or return the slot again. Ownership existed before the callback became possible.

## End execution ownership exactly once

The submission path passes a cleanup callback:

```java
executor.submit(attemptId, batch, () -> releaseExecution(attemptId))
```

The executor contract requires that callback to mean execution finished, failed and stopped, or was confirmed stopped. “Cancellation received” is not enough.

The cleanup transition is small:

```java
public boolean releaseExecution(long attemptId) {
    lock.lock();
    try {
        AttemptState state = activeAttempts.get(attemptId);
        if (state != AttemptState.HANDING_OFF) {
            return false;
        }
        activeAttempts.remove(attemptId);
        changed.signalAll();
        return true;
    } finally {
        lock.unlock();
    }
}
```

Only removal returns capacity. Duplicate cleanup finds no owned entry and returns false. A late callback cannot remove another attempt when identities are never reused.

The condition signal tells waiters to reconsider state; it does not assign the returned slot. They must reacquire the lock, check capacity, and register ownership atomically.

A separate abandonment operation removes only `RESERVED` attempts when the scheduler exits before commitment. Keeping these cleanup operations state-specific prevents pre-handoff failure handling from reclaiming capacity belonging to committed execution.

## A timeout ends waiting, not execution

The scheduler currently preserves ownership through its documented cleanup paths. It does not contain a request-timeout API or backend cancellation protocol. Its public release method cannot independently verify why it was invoked; correct use still depends on the executor and caller contracts.

The new test makes that boundary observable with a controlled backend:

1. Submit two full-token batches and have the fake backend accept both without completing them.
2. Wait on a separate response future with a short timeout.
3. Verify the wait timed out and both attempt entries remain `HANDING_OFF`.
4. Explicitly finish A through its backend callback; verify only B remains.
5. Deliver A's completion again; verify B is unchanged.
6. Finish B; verify no execution ownership remains.

The caller-side timeout is:

```java
assertThrows(TimeoutException.class,
        () -> firstReply.get(20, TimeUnit.MILLISECONDS));
```

The ownership assertion immediately afterward is:

```java
assertEquals(bothOwned, ownership(scheduler),
        "Both execution slots must remain owned after the caller stops waiting");
```

The fake backend cannot finish spontaneously, so the test does not depend on scheduling execution “slowly enough.” The timeout duration is a test bound, not a serving deadline. This verifies the demonstrated composition of caller waiting and backend completion; it does not prove the behavior of a future HTTP timeout handler.

Result delivery is another responsibility. A real service might discard a response after disconnection, store a background result, or request cancellation. None of those policies justifies returning execution capacity before the work stops. Because our slots belong to batches, cancelling one request would not establish that the entire batch has completed.

## Shutdown must preserve committed cleanup

Shutdown and commitment serialize through the same lock. If shutdown wins, the uncommitted reservation is reclaimed. If commitment wins, submission remains authorized, even if its physical executor call begins after shutdown starts.

Shutdown preserves `HANDING_OFF` attempts. Their completion callbacks must still release ownership afterward.

One review bug violated this rule by returning early from cleanup whenever shutdown was true. Finished batches remained in the active map. The correction was to keep admission decisions separate from cleanup eligibility.

This is only partial shutdown behavior. The current submission method still accepts pending requests after shutdown, and integrated dispatch stops without draining them. The design must choose whether queued work is drained, cancelled, or returned before it can promise graceful shutdown and full termination.

## Waiting also changes what the scheduler knows

Ownership is only as sound as the decision that selects the work. A condition wait releases the lock, allowing producers and cancellation callers to change the queue.

A candidate describing three requests may be invalid after waiting for capacity if one request was cancelled. It is an inspection result, not a protected reservation of those requests.

The corrected capacity branch waits once and restarts the outer decision loop:

```java
if (activeAttempts.size() >= MAX_EXECUTION_SLOTS && !shutdown) {
    changed.await();
    continue;
}
```

After waking, the outer loop checks shutdown, queue contents, batch readiness, and capacity again. This preserves pending ownership until a fresh decision can commit and detach the selected requests under one lock.

## Tradeoffs of the design

| Choice | Benefit | Cost or limitation |
| --- | --- | --- |
| One shared lock | Straightforward atomic queue/ownership transitions | Contention must be measured under realistic load |
| Active map instead of a separate counter | Identity and capacity share one representation | Every access must follow the synchronization contract |
| Requests stay pending until commitment | Cancellation remains meaningful while waiting; no detached backlog to recover | Selection must be recomputed after waits |
| Executor called outside the lock | Backend latency and callbacks do not hold queue coordination hostage | Ownership must be established before the call |
| Explicit rejected-batch result | Work is returned to an identifiable owner | Caller must choose retry, cancellation, or failure reporting |
| Retain ownership on uncertain acceptance | Avoids releasing capacity while work might still run | Missing completion can stall capacity; recovery is unresolved |

A semaphore can count permits, but does not by itself provide attempt identity, commitment, or idempotent cleanup. The map and lock are one understandable composition for this exercise, not a claim that they are universally faster.

Ordinary rejection must explicitly guarantee that work will never execute. Unexpected runtime exceptions and null results are treated as uncertain submission; the exception carries the detached batch and attempt ID. Automatic release or retry would require stronger evidence.

## Evidence and remaining work

The current scheduler suite has six passing tests: five shutdown/handoff tests and the caller-timeout ownership test. The shutdown tests include deterministic orderings and one concurrent start-gate trial with bounded waits, failure propagation, and worker cleanup. This is evidence for those scenarios, not an exhaustive concurrency proof.

Temporary smoke checks also exercised accepted dispatch, inline/duplicate completion, rejection cleanup, and stopped dispatch. The stale-candidate correction compiled, but a committed regression test for cancellation while capacity is full remains outstanding.

Separate [performance](https://github.com/galt-k/galt-projects/tree/main/java/concurrency-lab/problem-003-inference-batch-scheduler/performance-investigation) and [deadlock](https://github.com/galt-k/galt-projects/tree/main/java/concurrency-lab/problem-003-inference-batch-scheduler/deadlock-investigation) exercises explore progress and lock coordination. Their current implementations contain the fixes. The performance simulator's baseline and incident modes therefore no longer reproduce the historical before/after defect. Those historical numbers are not used here as evidence of integrated-scheduler performance.

Before connecting a real backend, the work remaining includes queued-request shutdown policy, full termination, safe visibility for the public shutdown getter, caller-result delivery and cancellation, bounded admission, and recovery from uncertain acceptance. The integrated path also needs load measurements and tests for cancellation during capacity waiting. This prototype has no crash-durability guarantee.

## The lesson to carry forward

An execution slot represents an obligation that persists until the work is definitely rejected or stopped. A caller deadline, a disconnected client, and an execution-completion event provide different evidence and should drive different transitions.

Making those distinctions explicit gave the Java implementation its structure: register before callbacks, commit before detachment, validate and remove ownership atomically, and refresh decisions after waits. The next step is to test each boundary under failure and measure the integrated system before drawing throughput conclusions.

Explore the [implementation and tests](https://github.com/galt-k/galt-projects/tree/main/java/concurrency-lab/problem-003-inference-batch-scheduler) and the [full engineering design](https://github.com/galt-k/galt-projects/blob/main/java/concurrency-lab/problem-003-inference-batch-scheduler/design.md).
