# Security incident and update procedures

Repository maintainers use this procedure to prepare, verify and record a scoped
security response for 101. Local investigation, fixes and release preparation are
permitted under the repository's local-only policy. Live intake, communications,
distribution and a stable support promise require the owner assignments and
authority below. The [security policy](../../SECURITY.md) governs reporting; the
[release contract](RELEASE-CONTRACT.md) governs qualification and release claims.

## Required owners and destinations

The owner authorized the active 101 integration controller to own security triage
and approve fixes within the existing local repository scope on 12 October 2026.
Those local decisions require no further approval question. Live reporting,
distribution and support assignments below remain **unconfigured**. Do not route
sensitive material to an invented address or open a public issue to work around a
missing private contact.

| Required assignment | Owner must supply and verify | Acceptance dependency |
| --- | --- | --- |
| Private reporting contact | An owned private destination, permitted recipients, access controls and a successful benign reporting-path check | L02 |
| Triage owner and fix approver | Active 101 integration controller for local repository decisions, authorized by the owner. Staffed live response, substitute coverage and any response expectations remain to be supplied | Local decision authority assigned; live S16/O08 obligations remain open |
| Update channel owner | The actual selected distribution destination, account/signing requirements and authority to operate it | L04 |
| Supported release window | Exact versions/profiles covered, maintenance duration or end condition, and how recipients learn of changes | L02, L04 |
| Authorization for live actions | Concrete artifacts, recipients/destinations, actions, validation, recovery plan and explicit owner approval | L05; execution evidence under L06–L07 |

Retain a redacted local preparation packet and label the unconfigured live steps
pending. Local decision authority does not establish on-call coverage, a response SLA,
delivery to a reporter, a released fix or accepted support. The current
[support catalog](support-catalog.json) has no accepted rows.

## Intake and triage

1. Receive a report through the verified private contact and assign its triage
   owner before dispatching it. If a report arrives through an unapproved route,
   restrict access and establish a permitted private handling destination; do not
   forward its contents or expose it publicly. Request only the minimum evidence
   needed to assess it.
2. Record an incident identifier, receipt time, optional reporter-provided contact,
   exact affected commit/tree or release version, package/build hashes, and the
   OS/runtime/connector/profile/resource target. Include expected and observed
   behavior, a minimized reproduction, source provenance, affected authority,
   prerequisites, reachability, impact, limitations and unknowns.
3. Preserve the original outcome before changing inputs or implementation. Bind
   source, packed and installed bytes separately where they differ. Remove tokens,
   keys, pairing material, recordings, device contents and identifying sample data
   from durable repository receipts. Keep sensitive originals only in an already
   authorized restricted destination with an agreed retention/removal policy;
   never commit them to Git or an evidence ref.
4. Classify the report as confirmed, unresolved or not reproduced within the
   tested scope. Assess priority from reachable impact, exposure, exploit
   prerequisites and available containment. A package name or advisory label
   alone does not establish impact: retain the exact advisory identifiers and
   affected-version ranges, the actual entry point and any legitimate controls.
   Do not turn missing prerequisites or a timeout into a pass.

The triage record names the decision maker, next action and remaining evidence.
An unresolved cause stays unresolved even if a later unchanged run passes. The
fix approver reviews the affected scope and validation before approving a fix;
the procedure supplies no blanket approval for device access or live operations.

## Containment and recovery

Identify the exact affected owner, resource, session, enrollment, key or package
generation. Request Stop or revoke only within that owned authority. Device or
account actions require the relevant owner's actual permission; an incident does
not grant access to unrelated systems. Suspend affected use or a local release
claim where safe containment or qualification is uncertain.

Record three outcomes separately: requested teardown, actual native settlement
and verified data removal. Retain unresolved already-issued or non-idempotent
effects, held reservations and cleanup failures. A handler return, `pending: 0`,
`onClose` or optional `whenSettled()` cannot prove detached native work has ended.
Join owned child processes and timers before removing their test state. Never
kill unrelated processes or claim erasure from a missing path alone.

Recovery requires fresh enrollment and fresh resource approvals where authority
was retired. Do not copy old bearer credentials, sessions, grants or endpoint
handles to a replacement. Preserve current owner, revocation, deletion and
retention floors through restore and rollback; expired or deleted data and
retired authority must not reappear. Unknown containment remains a blocker for
the affected scope.

## Repair and qualification

Reproduce the demonstrated problem against the old implementation with the
smallest faithful check and preserve the failure. Repair the narrow cause, then
run the current negative case and legitimate controls. Record exact inputs,
versions, hashes and observed outcomes. A retry, prewarm, widened deadline,
filtered suite or fixture unlike the actual producer does not establish a repair.

Freeze the changed candidate and obtain the independent review required for its
new or changed trust boundary. Record the reviewed revision, scope, findings,
dispositions and limits. Preserve prior completed reviews; a documentation update
does not require restarting an accepted investigation. Reopen affected support
combinations when source or their OS/runtime/device/connector/profile/codec/
resource identity changes. Historical receipts remain historical and cannot
qualify the replacement.

Every local commit passes the repository gates on the exact candidate: types,
lint, full unit tests and rendered HTML, using a fresh build after source changes.
Audit the task/evidence ledger after updating it. Also run the affected contract,
runtime, security, upgrade or recovery checks required by the release contract.
Do not close a full security task from a narrowly passing regression or procedure.

## Security update and rollback preparation

Prepare a versioned update packet containing the incident ID; exact affected and
fixed versions/profiles; fix revision and reviewed dependency/lockfile changes;
source, packed and installed artifact hashes; passed gates and scoped receipts;
remaining failures and prerequisites; required user action; and a recovery plan.
State whether each artifact is prepared locally, distributed or actually consumed.

Exercise representative upgrade, rollback and incident paths on disposable owned
state when required by the changed scope. A rollback destination must preserve
current security and data floors. Do not recommend returning to a known affected
version without a demonstrated containment measure and an explicit decision from
the authorized owner. If a safe rollback cannot be established, keep it unavailable
and prepare a fix-forward recovery path rather than reviving retired authority.

The [selected operator drill receipt](receipts/2026-10-06-watch-operator-drills.json)
records historical `local-operator-recovery-drills/1` software checks: 32 drill and
4 CLI checks for representative upgrade, rollback and incident paths on its named
source. It does not prove a current execution, installed Hub distribution,
production rollout, persistent account/key state, arbitrary operator data,
SIGKILL recovery or physical qualification. Use it only within that scope.

Present the concrete communications and update packet with the required owners
and destinations for L05 approval. No external message, public advisory, push,
publication, deployment or new service is authorized by this procedure. After
explicit authorization, retain actual delivery/distribution and consumption
readback for L06–L07; a local commit cannot supply those results.

## Incident closure

The assigned owner records containment and settlement outcomes, the verified fix
and target identity, required current qualification, delivered updates where
authorized, remaining exposure, evidence retention/removal outcomes and a named
follow-up owner. Close only the verified scope. Leave reporting-path, update,
support or physical prerequisites pending when their evidence is absent; track
the next action and its acceptance condition.

The [selected parser cost receipt](receipts/2026-10-12-onvif-parser-cost.json)
measures original and repaired gateway callers at 4, 8 and 16 KiB, with all eight
attempts per caller. This finite corpus does not establish exhaustive worst-case
cost or accepted camera support. S16 remains open for broader independent
validation, remaining input provenance and wider resource-cost qualification. L02,
L04 and L05 retain the unconfigured live reporting and update prerequisites above.
This local procedure adds no accepted support row or full release acceptance.
