---
name: socratic-reasoning
description: "Use an agent-advisor questioning loop for uncertain debugging, diagnosis, or design, or explicit Socratic reasoning. Gather evidence for assumptions/competing explanations. Not interviews, routine coding, or agreement loops."
compatibility: Requires Pi with preset-aware advisor, advisor_sessions, and advisor_close tools and a configured advisor model.
---

# Socratic reasoning with an advisor

You are the main agent. Use the advisor as a questioning partner, not an authority.
This skill guides your tool use. The advisor cannot read this skill or inherit your conversation.
It receives only its selected preset prompt and your explicit consultation messages.

Use concise explanations and evidence summaries. Do not request or transmit private chain-of-thought.
Do not require JSON, response markers, or a fixed answer format from the advisor.

## Frame the issue

1. State the objective and the task's acceptance criteria.
2. Separate observations and test results from interpretations, assumptions, and hypotheses.
3. State competing explanations, uncertainty, constraints, and what would disprove your current explanation.
4. Name the unresolved question that could change your next action.

If missing requirements change the goal or acceptance criteria, stop for a user-owned decision.
Do not turn that decision into a Socratic interview with the user.

Before each advisor call, check the unresolved question and the permitted scope of investigation.
Respect any user limit on calls, time, tokens, or spending before another call.
Provider calls may incur charges. This skill grants no spending permission and does not enforce billing limits.
If required authorization is missing, stop and ask the user.
If the advisor tools or model configuration are unavailable, report the blocker without a provider call.
Do not install packages or change settings to make the loop work.

## Ask the advisor

Start with `advisor({message, preset: "socratic-reasoning"})`.
Continue an existing same-issue consultation only when its discovered preset is `socratic-reasoning`.
Do not supply preset on continuation; the selected prompt remains pinned.
If the advisor tool does not expose preset, stop and report the incompatible version without a provider call.
Ask focused questions rather than a finished solution.
Request a challenge to the weakest assumption, alternative explanations, and evidence that would distinguish them.
Explain that you will gather the evidence and return the results.
Include the framing explicitly. Do not substitute a code dump or unexplained log for that framing.
Keep the returned session identifier.

Example opening tool input, not a required message format:

```json
{
  "preset": "socratic-reasoning",
  "message": "Objective: repair a worker wakeup defect. Acceptance criteria: queued work runs, and shutdown still completes. Observations: the queue contains work but the worker remains asleep. Assumption: the notification is lost. Alternative explanation: the predicate is stale. Uncertainty: when the signal fires relative to the wait. Constraint: preserve the lock contract. Act as a Socratic questioning partner. Ask focused questions rather than a finished solution. Challenge my weakest assumption and suggest a check that distinguishes these explanations. I will collect evidence and report back."
}
```

## Gather evidence

1. Identify the advisor's testable questions and claims.
2. Select a check that can distinguish the competing explanations or falsify an assumption.
3. Inspect, test, or measure with your own available tools within the authorized task scope.
4. Record the result, its source, and its limitations.
5. Revise your explanation only where the evidence supports the change.

Advisor claims are not evidence or authorization. Independently verify factual claims before acting on them.
Challenge unsupported advisor assertions as well as your own assumptions.
Do not run a proposed action merely because the advisor recommended it.
Do not expand the task, access permissions, or data collection to satisfy an advisor request.
Do not send secrets, credentials, or unnecessary private data.
Ask for a check you can perform, not for tool execution or hidden repository access by the advisor.

## Continue or stop

Check these conditions in order before another paid call:

1. If the user cancels or a user limit is reached, stop.
2. If an advisor call returns a failure, stop and retain its reported error. Do not retry automatically.
3. If the session is missing or the advice cannot support a testable next step, stop and report the blocker.
4. If the task's acceptance criteria justify a next action, stop questioning and take only an authorized action.
5. If the next step needs a user-owned decision or missing authorization, stop and ask the user.
6. If the needed evidence is inaccessible within the authorized task scope, stop and report what remains unknown.
7. If there is no new evidence and no new testable distinction, stop. Reworded questions do not count as progress.

Advisor agreement does not satisfy acceptance criteria. Advisor disagreement does not invalidate a verified check.
Do not continue merely to get agreement or certainty.
A new testable distinction must name competing explanations and a check with different expected results.
Do not introduce unrelated hypotheses to prolong the loop.

If no stop applies, continue the same session with `advisor({session, message})`.
Supply new evidence or a new testable distinction, the revised explanation, and the remaining question.
Say which advisor claim the result supports or contradicts. Request the next focused question, not repeated advice.

Example continuation tool input:

```json
{
  "session": "adv_<returned-id>",
  "message": "New evidence: tracing shows the signal fires before the worker waits. The predicate changes outside the lock. This contradicts my assumption that notification timing alone causes the defect. The shutdown requirement is unchanged. Would a locked predicate check distinguish a missed state change from a lost notification? Challenge this test and ask the next focused question."
}
```

If you lose the identifier, use `advisor_sessions({})` to locate your same-issue consultation.
Discovery returns metadata, not transcripts. Check same-issue identity and `preset: "socratic-reasoning"`.
If the preset mismatches, stop and report it without automatic replacement or reconfiguration.
Do not guess an identifier or reuse an unrelated consultation.
If you cannot identify the consultation, stop. Do not automatically start a replacement consultation.
Consultations are ephemeral. Restart, reload, or session navigation can remove them.

## Finish

Close your idle consultation with `advisor_close({session})` when the loop ends.
If close reports a busy or missing consultation, report that result without repeated close attempts.
Do not close consultations owned by another task.

Report the evidence, the next action or unresolved question, and the stop reason.
Separate observed results from hypotheses and advisor suggestions.
The user retains decisions about preferences, policy, spending, and actions that require approval.

Tool inputs and replies can persist in the parent transcript. Provider retention rules still apply.
Closing removes local consultation state. It does not erase the transcript or provider caches.
This skill does not enforce model compliance or termination and does not promise better reasoning.
