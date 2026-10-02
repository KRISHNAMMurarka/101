# M04 binary and document resource implementation plan

1. Add RED model tests for exact inert asset references, MIME/kind pairing,
   byte/hash bounds, valid and invalid UTF-8/JSON content, and immutable
   snapshots. Implement the smallest public model functions.
2. Add RED runtime tests for chunk snapshotting, contiguous order, max chunk
   and total sizes, digest mismatch, truncated/trailing streams, per-read
   authorization, grant expiry and cancellation of a stalled async iterator.
   Implement a bounded reader with prompt abort and no partial result.
3. Add a first embedded caller for two separately authorized document reads.
   Show verified text and JSON, denial, corruption and stop/cancellation through
   the public facade. Keep a simulated label and no implicit URL/filesystem
   access.
4. Include the caller and public functions in the five-package SDK allowlist;
   extend strict external types, ordinary Node and three-browser packed checks.
   Obtain read-only risk review if the transfer/lifecycle change is substantial.
5. Freeze an immutable producer tree, run clean external package QA and exact
   TypeScript/lint/unit/fresh-build/rendered gates. Record receipts, audit the
   master ledger, mark only M04's bounded local contract and commit locally.

The controller owns shared packages and evidence. Each bug fix regression
must fail on the old implementation before the fix. No remote publication or
physical support claim is in scope.
