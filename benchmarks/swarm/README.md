# Swarm v2 invariant harness

`node --import tsx benchmarks/swarm/v2-invariants.mjs`

Runs the real `CoordinationService` + SQLite through controller-style project/session binding and asserts I1–I18 where P0/P1 implements them: member phase/name/admit gates, task CAS/DAG, one-running attempt, write-scope overlap, message idempotency/wait bounds, stop receipts, exact-tip/structured verdict, 20 merge gates with applied receipt and zero silent merges, baseline drift rejection, budget hard limit, journal monotonicity and deterministic projection rebuild.

Output: `.artifacts/qa/swarm-v2-invariants.json`. This is a deterministic mechanism/invariant harness, **not** a paired real-model quality benchmark; real-model quality, cost, packaged Computer Use and P2–P4 capabilities remain separate acceptance gates.
