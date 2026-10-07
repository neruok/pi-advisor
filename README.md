# Pi advisor

A standalone Pi extension for isolated, multi-turn consultation. The main agent explains a problem. The advisor challenges assumptions and recommends evidence or next steps.

The advisor receives only the fixed advisor prompt and explicit consultation messages. It has no tools, code access, parent conversation, or workspace instructions. It does not use pi-magic8ball.

## Try it

From this directory, load it for one invocation:

```sh
pi -e ./advisor.ts
```

No profile change is required. The package is local and unpublished.

Choose a physical chat model already configured in Pi:

```text
/advisor model <provider> <model-id>
/advisor show
```

A bare `/advisor` opens an inline searchable picker in TUI mode, matching `/model` and pi-magic8ball. Type to filter by provider, identifier, or display name. Arrow keys navigate. Enter selects. Escape or Ctrl+C cancels without saving.

The picker marks the configured advisor model and shows at most ten model rows. RPC retains the standard selection dialog. Without UI, commands emit a custom transcript message and do not start a model turn. JSON mode exposes that message as an event.

Saves default to `<agent-dir>/advisor.json`. Use `--project` for `<cwd>/.pi/advisor.json`. Project reads and saves require current Pi project trust. A project selection replaces the whole global model pair.

```json
{
  "model": { "provider": "your-provider", "model": "your-model-id" }
}
```

Use normal Pi authentication. No model fallback occurs. Configuration changes affect new consultations only.

## Reasoning effort

```text
/advisor reasoning
/advisor reasoning high
/advisor --project reasoning medium
```

The query shows the effective model, configured effort, and supported choices without a provider request or settings write.
Set effort with `default`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Only advertised model levels are accepted. Unsupported levels return `unsupported-reasoning`; the extension does not clamp them or select another model.

Settings store effort inside the complete model selection:

```json
{
  "model": { "provider": "your-provider", "model": "your-model-id", "reasoning": "high" }
}
```

Omitted effort and `default` keep legacy provider behavior, without inheriting the parent thinking level. As in pi-magic8ball, `off` omits the SDK reasoning option and requires advertised off support. Other explicit levels reach each request unchanged. Provider adapters can map those levels to model-specific budgets. Higher reasoning can increase cost and latency; it is not a monetary cap or a guarantee of provider behavior.

The model and reasoning are pinned for each consultation. Existing sessions do not change when you edit settings. Explicit effort appears in result and discovery model metadata. Expand a reply to see its effort label. Thinking remains excluded from advice and history.

Global writes use the global model, not a project override. Trusted project writes copy the effective complete selection when necessary. A project selection replaces the whole global selection, including effort. Selecting a model through the command or picker resets effort to legacy behavior; set effort afterward.

## Command autocomplete

The registered `/advisor` argument autocomplete suggests subcommands, scope flags, available physical chat providers, fuzzy model identifiers/names, and supported reasoning levels. One scope flag can appear before, between, or after arguments. Reasoning suggestions target the save scope: global by default, or the effective model for a trusted project.

Selecting a suggestion inserts text and does not save settings or run a model. Submit the command to apply it. Dynamic choices use current catalog and settings snapshots without remote catalog refreshes.

Pi 1.0.4 has a Tab-routing limitation after command-name completion: accepting `/advisor ` with Tab can make another Tab miss argument completion. Type an argument prefix, such as `rea`, and wait for its completion menu, then accept the suggestion. This extension does not replace or patch the host editor.

## Consultation tools

Start:

```json
{ "message": "Objective: fix the timeout. My understanding: workers wait for a queue signal. Evidence: the queue contains work, but no worker wakes. Constraint: preserve shutdown behavior. Uncertainty: signal loss or lock contention? What should I test?" }
```

`advisor` returns a session identifier, free-form response, committed exchange count, pinned model, per-call usage, and cumulative usage.
The extension constructs the structured result envelope. It does not require the model to produce JSON, markers, or a status label, and it does not interpret the advice.

`usageComplete` describes this call's reported usage. `totalUsageComplete` describes the known consultation total.
These flags describe local reporting, not verified provider billing. A completed rejected reply still reports its usage.
An unobserved completion makes cumulative usage incomplete for the rest of that consultation, even after later successes.
Failures include cumulative usage when the requested consultation still exists. The host receives per-call usage only.

The collapsed TUI result shows replies of at most eight wrapped advice rows in full. Longer replies show the first eight advice rows and an expansion hint. Expand for full advice, model, and cumulative usage details. The cutoff uses the current terminal width, with no character-count cap. The advisory label and reported usage remain visible in both views.
Responses stay in the existing tool result. No duplicate chat messages or new model requests are added when you expand.
Pending updates show preparation or waiting only. They never show partial advice, thinking, or the explicit input.

Continue through `advisor`:

```json
{ "session": "adv_<returned-id>", "message": "I traced the signal. It fires before the worker begins waiting. How can I distinguish a lost wakeup from a stale predicate?" }
```

`advisor_sessions({})` lists identifiers and metadata, not transcripts. Finish with `advisor_close({"session":"adv_<returned-id>"})`.

Each entry includes known cumulative usage, `totalUsageComplete`, `turnsRemaining`, `historyBytes`, and `historyBytesRemaining`.
Capacity counts committed exchanges only. A pending request marks cumulative usage incomplete until its outcome is known.
Byte capacity is not a token estimate or a guarantee that another exchange will fit.

Success results and session metadata have no status classification. Advice never automatically closes a consultation or executes an action.

The main agent must gather requested evidence and verify factual claims. Advice is not evidence or authorization. Ask the user when an action requires approval.

## Limits and retention

Consultations are ephemeral. The extension stores no separate consultation files and does not restore history after restart or reload.

Session replacement, fork, tree navigation, shutdown, or reload clears consultations. Parent compaction retains them. Pi can still persist tool arguments and results in its parent transcript. Closing a consultation does not erase that transcript. The provider receives the supplied messages and applies its own retention policy. Do not include secrets.

Hard local limits:

- 8 active consultations, including pending creation.
- 24 successful user/reply exchange pairs per consultation.
- 16384 UTF-8 bytes per user message or raw advisor reply.
- 49152 UTF-8 bytes of serialized `{role,text}` history.
- 120000 ms deadline per call.

Each request asks for at most 4096 output tokens. Byte limits do not guarantee fit within every model's token context. Provider calls may incur charges, including replies rejected by validation. No monetary cap is enforced.

Limits fail closed. The extension never evicts or silently summarizes history.
Limit failures retain `error.code = "limit-exceeded"` and add `error.limit = {resource, maximum, actual}`.
Measurements use UTF-8 bytes or attempted exchange/session counts. Bounds are inclusive.

| Resource | Recovery |
| --- | --- |
| `input-bytes` | Send a shorter message. |
| `reply-bytes` | Request a shorter answer. |
| `history-bytes` or `turns` | Start a new consultation with your own explicit summary. |
| `sessions` | Close idle consultations. |

One request may run per consultation. Overlapping requests and busy close return `busy`. Cancellation and provider failure leave previous exchanges intact. The extension makes no automatic retries. A provider that ignores cancellation can complete later, but its reply cannot change consultation state. Late usage may be unavailable. If a completion attempt produces no observed response, `usageComplete` is false.
A zero usage value with that flag does not mean zero cost. Remote work can continue after local cancellation.
An unavailable model during a completion attempt can also produce incomplete usage. The extension does not infer remote billing from an exception.

Replies must contain nonblank text and finish normally. Empty replies, incomplete completions, malformed content, or tool calls fail with `invalid-response`.
The fixed error message identifies abnormal completion, malformed content, or absent text. Thinking blocks are removed; text blocks are joined with a newline without trimming or parsing their contents. Marker-looking strings are ordinary text.
It does not expose rejected advice, thinking, provider field values, or raw provider messages. A failed exchange never enters history.
Keep the rejection message when reporting a live failure. Stop rather than retry or relax validation. Earlier generic errors cannot reveal the exact violation after the reply is discarded.

Settings locks coordinate participating writers. An unrelated writer can still race between the final byte comparison and replacement. Parent-directory races and provider code remain outside an operating-system sandbox.

## Opt-in live verification

Offline checks remain provider-free. Use this manual procedure only when a user requests a live compatibility check.
It checks one consultation and one continuation, not reasoning quality or universal provider support.

1. Get separate spending authorization for a designated physical model and at most two requests.
2. Disclose that the extension has no local monetary cap. Use a provider-side budget if a hard spending cap is required.
3. Record the provider/model and Pi and Node versions. Use normal authentication. Do not copy credentials into the report.
4. Use `/advisor show` to check the effective model. Select the designated model only with authorization for that settings change.
5. Ask the main agent to call `advisor` with nonsecret text: "Recommend one offline check for a pure integer addition function."
6. Check success, `advisory: true`, the free-form response, returned session identifier, model, `usage`, `usageComplete`, and `totalUsageComplete`.
7. Continue that session: "I have not run the proposed check. Suggest one boundary case for that function."
8. Check that the model remains pinned, turns equals two, and reported cumulative usage includes both calls.
9. Close the idle session with `advisor_close`. Confirm that `advisor_sessions` no longer lists it.
10. Report versions, provider/model, outcomes, reported usage, completeness, and whether the session closed.

Use no automatic retries. Stop after any failure, including an invalid reply. Close any existing idle consultation before reporting.
Do not spend a replacement request on a failed call. Do not try to induce malformed replies with paid requests.
If cleanup reports busy, inspect the pending state before another action. Do not claim that local abort stops remote billing.
Never describe an offline pass as live provider interoperability.

## Development

```sh
npm ci --ignore-scripts
npm run verify
```

Tests use Node's test runner, mock model responses, and private temporary settings directories. TypeScript checks the extension and core. Pi and TypeBox remain host-provided runtime peers.

Verified against Pi 1.0.4 on Node 24, on Linux. Offline tests verify deterministic boundaries and package loading, not reasoning quality or live provider compatibility. Paid provider tests require separate authorization.

The specification is generated at `docs/pi-advisor.md` from document `pi-advisor` in the maintainer workspace store. Author through checkout, preview, import, and compile. Do not edit the generated file.
