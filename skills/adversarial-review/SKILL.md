---
name: adversarial-review
description: >
  Challenge a proposed fix, design, or implementation through an isolated advisor.
  Seek concrete counterexamples, failure conditions, missing tests, and unsupported
  claims, then verify findings with the main agent's tools. Use before accepting a
  candidate answer or for an explicit adversarial review, not open-ended diagnosis,
  a user interview, or repeated requests for approval.
compatibility: Requires Pi with preset-aware advisor, advisor_sessions, and advisor_close tools and a configured advisor model.
---

# Adversarial review with an advisor

You are the main agent. Review a concrete candidate answer rather than explore an undefined problem.
Use Socratic reasoning for an unresolved problem without a candidate to challenge.

This skill guides your tool use. The advisor cannot read this skill or inherit your conversation.
It receives only its selected preset prompt and your explicit consultation messages.
The review is review-only unless the user also authorized implementation.
Do not implement a proposed fix unless the user authorized that work.

## Frame the candidate

1. Record the candidate identity: repository revision and uncommitted diff, or the exact proposal version.
2. State the requirements, acceptance criteria, intended behavior, and constraints.
3. Summarize relevant source, interfaces, tests, observed results, assumptions, and known gaps.
4. Select review dimensions tied to those requirements and the user's scope.

Check boundaries, failure handling, concurrency, rollback, compatibility, or privacy where the candidate affects those dimensions.
Do not imply that every dimension applies or that this list establishes complete coverage.
Include relevant excerpts and locations when the advisor needs them. Do not send an unexplained code dump.
If there is no concrete candidate, report that blocker before calling the advisor.
If missing or conflicting requirements affect the review, stop for a user-owned decision. Do not invent policy or preferences.

Before each advisor call, check the candidate identity, review scope, and any user limit on calls, time, tokens, or spending.
Provider calls may incur charges. This skill grants no spending permission.
If required authorization is missing, stop and ask the user.
If the advisor tools or configuration are unavailable, report the blocker without a provider call.
Do not install packages or change settings to make the review work.
Do not send secrets, credentials, unnecessary private data, or private chain-of-thought.
Do not request private chain-of-thought from the advisor.
Do not require JSON, response markers, or a fixed answer format from the advisor.

## Ask for counterexamples

Start with `advisor({message, preset: "adversarial-review"})`.
Continue an existing same-issue consultation only when its discovered preset is `adversarial-review`.
Do not supply preset on continuation; the selected prompt remains pinned.
If the advisor tool does not expose preset, stop and report the incompatible version without a provider call.
Supply the framing explicitly and ask the advisor to challenge the candidate.
Request concrete counterexamples, failure conditions, missing tests, and unsupported claims.
For each concern, ask which requirement could fail, under what conditions, with what consequence, and how to check it.
Ask the advisor to identify missing evidence instead of inventing facts about unseen code.
Do not demand a defect quota or require the advisor to find a problem.
Do not invent defects to make the review appear useful.
Keep the returned session identifier.

Example opening tool input, not a required message format:

```json
{
  "preset": "adversarial-review",
  "message": "Review candidate worker-wakeup proposal v2, not the whole service. Requirement: queued work runs and shutdown completes. Candidate: check the queue predicate under the lock, then wait in a loop. Evidence: the supplied excerpt has the predicate and wait under the same lock. The single-worker test passes. Assumption: shutdown uses that lock too, but I have not inspected it. Challenge this candidate with concrete counterexamples, failure conditions, missing tests, and unsupported claims. Connect each concern to a requirement and suggest a check. Do not invent repository facts or require a quota of defects. I will verify your claims with local evidence."
}
```

## Verify findings

Advisor claims are not evidence or authorization. Independently verify factual claims before acting on them.
For each concern, identify the affected requirement, triggering conditions, expected behavior, and claimed consequence.
Inspect the relevant source or perform a covering test within the authorized task scope.
Record the source, candidate identity, observed behavior, and limitations of that check.

Use these labels as main-agent bookkeeping, not a required advisor protocol or extension result fields:

- **Confirmed**: evidence for this candidate shows a reachable violation of a stated requirement. Explain the consequence and conditions.
- **Refuted**: covering evidence contradicts the claimed failure under its stated conditions. Explain the coverage and its limits.
- **Unresolved**: evidence is absent, inaccessible, conflicting, or does not cover the claimed failure. State the missing check or decision.

A non-covering test does not refute a concern. A passing happy-path test does not establish a failure path's correctness.
An untested suggestion is a hypothesis, not a confirmed defect.
Distinguish a missing test from a demonstrated implementation failure.
A preference, optional improvement, or unsupported policy demand is not a defect. Keep it separate from requirement violations.
Judge priority from the supported consequence and reachable conditions, not the advisor's severity label alone.

Do not expand the review scope, access permissions, or data collection to satisfy an advisor request.
A suggested test does not authorize production access, exploit execution, destructive actions, or extra spending.
If a check needs additional authorization, stop that check and report the concern as unresolved.
Do not change the candidate during review-only work.

## Continue or stop

Check these conditions in order before another paid call:

1. If the user cancels or a user limit is reached, stop.
2. If an advisor call returns a failure, stop and retain its reported error. Do not retry automatically.
3. If the consultation is missing or advice is unusable, stop and report the blocker without starting a replacement consultation.
4. If further verification needs missing authorization or inaccessible evidence, stop and report the unresolved concerns.
5. If the requested review dimensions are checked and remaining gaps are identified, stop and report the review.
6. If there is no new evidence, changed candidate, or previously unexamined testable concern, stop. Reworded criticism does not count as progress.

A testable concern names a requirement, triggering conditions, and a check that could support or refute its claimed failure.
A changed candidate counts as progress only if a named review claim or requirement changes.
Do not add unrelated review dimensions or speculative issues merely to prolong the consultation.
Do not continue until every concern disappears. Report unresolved concerns instead of seeking agreement or certainty.

If no stop applies, continue the same issue in the same session with `advisor({session, message})`.
Supply new evidence, a changed candidate, or a previously unexamined testable concern and the remaining review question.
Challenge unsupported advisor criticism when evidence contradicts it.
For a changed candidate, state its new identity, changed behavior, and relevant requirements or constraints.
Keep earlier findings tied to their original candidate. Recheck the affected claims before applying them to changed behavior.
Do not silently transfer a confirmed or refuted finding to another revision.

Example continuation tool input:

```json
{
  "session": "adv_<returned-id>",
  "message": "Same candidate, worker-wakeup proposal v2. New evidence: shutdown sets the predicate and signals under the same lock. A covering wait-versus-shutdown test completes in both schedules. This refutes the proposed missed-shutdown case under those conditions, not all concurrency risks. The multi-worker claim remains unresolved because the fixture only runs one worker. Is that claim a requirement violation under a concrete schedule? Suggest a covering check without expanding the review scope."
}
```

If you lose the identifier, use `advisor_sessions({})` to locate your owned same-issue consultation.
Discovery returns metadata, not transcripts. Check same-issue identity and `preset: "adversarial-review"`.
If the preset mismatches, stop and report it without automatic replacement or reconfiguration.
Do not guess an identifier or use another task's consultation.
If you cannot identify it, stop without automatic replacement. Consultations are ephemeral.

## Report and close

Report the candidate identity, reviewed dimensions, findings, evidence, unresolved gaps, and stop reason.
Keep verified results separate from hypotheses and advisor suggestions.
No findings means no substantiated defects in the reviewed dimensions. It is not approval or proof of safety.
Criticism is also not a veto. The user retains policy, preference, spending, and approval decisions.
The review does not authorize a commit, release, deployment, or implementation.

Close your idle consultation with `advisor_close({session})` when the review ends.
If close reports a busy or missing consultation, report the result without repeated close attempts.
Do not close consultations owned by another task.

Tool inputs and replies can persist in the parent transcript. Provider retention rules still apply.
Closing removes local consultation state. It does not erase the transcript or provider caches.
This skill does not enforce model compliance, termination, or billing limits and does not promise complete defect detection.
