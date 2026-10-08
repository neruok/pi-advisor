# Pi advisor

A standalone Pi extension for isolated, multi-turn consultation. The main agent explains a problem. The advisor challenges assumptions and recommends evidence or next steps.

The advisor receives only the fixed advisor prompt and explicit consultation messages. It has no tools, code access, parent conversation, or workspace instructions. It does not use pi-magic8ball.

## Try it

From this directory, load it for one invocation:

```sh
pi -e ./advisor.ts
```

No profile change is required.
The unscoped npm package `pi-advisor` belongs to a different project; do not install it to get this extension.

Install this package from npm:

```sh
pi install npm:@neruok/pi-advisor
```

Or install this checkout persistently:

```sh
pi install /absolute/path/to/pi-advisor
```

Local installs load the checkout in place. Restart Pi or use `/reload` after changes.

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

The model and reasoning are pinned for each consultation. Existing sessions do not change when you edit settings. Explicit effort appears in result and discovery model metadata. Expand a reply to see its effort label. Plaintext thinking remains excluded from advice and history. Private opaque continuation state is described below.

Global writes use the global model, not a project override. Trusted project writes copy the effective complete selection when necessary. A project selection replaces the whole global selection, including effort. Selecting a model through the command or picker resets effort to legacy behavior; set effort afterward.

## Request timeout

The default deadline is five minutes (300000 milliseconds) per call, including preparation.
Inspect or change it with the user-only command:

```text
/advisor timeout
/advisor timeout 600000
/advisor --project timeout 900000
/advisor --project timeout default
```

`/advisor timeout` and `/advisor show` report effective milliseconds and their source without a provider call.
`timeout default` removes that scope's explicit timeout. A project then inherits the global timeout, or the five-minute default.
Global reset restores the five-minute default unless a trusted project has its own timeout.

Settings store an optional root `timeoutMs`:

```json
{
  "model": { "provider": "your-provider", "model": "your-model-id" },
  "timeoutMs": 600000
}
```

Accepted values are integers from 1 through 2147483647 milliseconds, inclusive, within Node's timer range.
Zero, null, strings, fractions, and out-of-range values fail validation. Command values use decimal integer text.
Timeout-only settings are allowed, but a model must still be configured before consultation.

Timeout precedence is independent of model selection: trusted project `timeoutMs`, global `timeoutMs`, then the default.
A project model without a timeout inherits the global timeout. A timeout-only project retains the global model.
Untrusted project settings remain ignored. Model, picker, and reasoning commands preserve the save scope's explicit timeout.

Each consultation pins its timeout with the model and effort. Settings changes affect new consultations only.
Every continuation gets a fresh call budget of that pinned duration. Preparation consumes part of the same budget, not an extra period.
Before settings resolve, preparation uses the five-minute default. A resolved timeout replaces that budget from the original call-entry time.
If that budget has already elapsed, the request stops before generation.
Caller cancellation remains active. Deadlines do not enable retries or guarantee remote cancellation or zero billing.

## Command autocomplete

The registered `/advisor` argument autocomplete suggests subcommands, scope flags, available physical chat providers, fuzzy model identifiers/names, supported reasoning levels, and `timeout default`. One scope flag can appear before, between, or after arguments. Reasoning suggestions target the save scope: global by default, or the effective model for a trusted project.

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
The call view shows the main agent’s message in full, including line breaks, with terminal controls neutralized.
The provider still receives the original message. Hidden reasoning and private replay never appear in that view.

Both result views show a Pi-like consultation usage line, for example:

```text
↑3.0k ↓500 R10k W2.0k CH60.0% $0.038 51.5%/20k
```

Input, output, cache reads/writes, and reported cost are cumulative for this consultation, including completed rejected calls.
CH uses the latest call: cache reads divided by uncached input plus cache reads plus cache writes.
Unknown prompt usage shows `CH?`. Incomplete cumulative reporting has an explicit warning.
Context uses the advisor's own estimate and model window, not the parent's totals. No subscription or auto-compaction labels appear.

Responses stay in the existing tool result. No duplicate chat messages or new model requests are added when you expand.
Pending updates show preparation or waiting only. They never show partial advice, thinking, or the explicit input.

Continue through `advisor`:

```json
{ "session": "adv_<returned-id>", "message": "I traced the signal. It fires before the worker begins waiting. How can I distinguish a lost wakeup from a stale predicate?" }
```

`advisor_sessions({})` lists identifiers and metadata, not transcripts. Finish with `advisor_close({"session":"adv_<returned-id>"})`.

Each entry includes known cumulative usage, `totalUsageComplete`, `turnsRemaining`, informational `historyBytes`, and `contextUsage`.
`contextUsage` contains `tokens`, `contextWindow`, and `percent`, based on committed history only.
A pending request marks cumulative usage incomplete until its outcome is known. Estimates do not guarantee another exchange will fit.

Success results and session metadata have no status classification. Advice never automatically closes a consultation or executes an action.

The main agent must gather requested evidence and verify factual claims. Advice is not evidence or authorization. Ask the user when an action requires approval.

## Opt-in failure diagnostics

For a requested call, add `"diagnostics": true` to the `advisor` input. Omission or `false` keeps the existing failure envelope. This option does not start another call or enable retries. Success results are unchanged.

Failures add `error.diagnostics` with a fixed `phase` and `category`. Phases are `validation`, `preparation`, `completion`, `response-validation`, and `commit`. When known, diagnostics include the effective or pinned `model` (including reasoning) and `selectionSource`: `global`, `project`, or `unknown`. Continuations retain the original selection source, even after settings change. If preparation fails before settings resolve, model metadata is absent.

Categories distinguish `local-error`, `provider-error` (terminal error response), `provider-aborted` (terminal abort response), and `advisor-error` (an extension-defined failure). Thrown completion errors can report `authentication`, `provider-rejection`, `rate-limit`, or `transport` from recognized own data fields: HTTP `status` 401/403, 400/404/409/413/422, 429, or 408/500/502/503/504 respectively; transport `code` values ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, and EAI_AGAIN also map to `transport`. HTTP status takes precedence. Other completion exceptions report `unknown`.

Terminal SDK errors can report `category: "sdk-error"` and `code: "sdk-invalid-timeout"`. This identifies the fixed timeout validation error. The renderer shows: "SDK timeout must be a positive integer." Requests use an integer remaining timeout without extending the local deadline.

The installed Responses adapter converts exceptions into terminal error text. Diagnostics read only its fixed SDK wrapper prefix, such as `xai API error (401): `. A matching wrapper adds `httpStatus` and the corresponding HTTP category. For xAI HTTP 400, an exact known rejection can add `code: "tool-choice-without-tools"`. This identifies a `tool_choice` setting without tool definitions. Unmapped statuses retain `provider-error`. Arbitrary error text, malformed wrappers, and unknown formats remain unclassified. Terminal aborts remain `provider-aborted`.

These are diagnostic hints, not proof of a remote root cause. A terminal `provider-error` can also represent an unrecognized local SDK failure. The extension compares only fixed known rejection details. It does not expose the provider body. Credentials, headers, raw errors, causes, arbitrary payloads, rejected advice, and thinking remain excluded. Diagnostic fields appear in the tool result and can persist in the parent transcript. Zero reported usage still does not establish zero billing. Stop after a failed live call; enabling diagnostics is not permission to retry.

## Provider prompt caching

Every request uses `cacheRetention: 'short'` through Pi's provider adapter, with a stable identifier for that consultation.
The fixed advisor prompt and validated exchanges form a reusable prefix. Continue the same session for the same issue.
Different consultations use different identifiers and do not share local history.

Validated replies can retain opaque replay state in process memory, private to the consultation:

- Responses APIs (OpenAI, Codex, Azure, and compatible providers such as xAI): encrypted reasoning items and text item IDs/phases. Plaintext reasoning and summaries are removed.
- Google Generative AI and Vertex: thought signatures on their original text/thinking blocks, with thinking text removed.
- Anthropic and Bedrock: opaque redacted thinking only. Ordinary signed plaintext thinking is not retained or replayed; caching or continuity that requires it remains unsupported.

Original text-block boundaries and API identity are preserved for these formats. Malformed or unsupported metadata is omitted.
Replay never appears in tool results, session listings, renderers, or separate files. Requests remain stateless: advisor does not enable server-side conversation storage or use `previous_response_id`.
Private replay commits only with a valid reply. Provider-reported context usage includes reasoning when the provider reports it.
Ciphertext size is not a model-token count and does not set the context limit.

Cache hits depend on the provider, model, prompt size, and time between requests. Short caching does not guarantee savings.
Pi controls cache payload construction and the provider controls cache lifetime. Advisor does not request extended retention.
The explicit short option takes precedence over the SDK's `PI_CACHE_RETENTION` environment default.

Closing a consultation does not delete provider caches or the parent transcript. It removes only the extension's local consultation state.
Provider retention policies still apply. Do not include secrets.

## Limits and retention

Consultations are ephemeral. The extension stores no separate consultation files and does not restore history after restart or reload.

Session replacement, fork, tree navigation, shutdown, or reload clears consultations. Parent compaction retains them. Pi can still persist tool arguments and results in its parent transcript. Closing a consultation does not erase that transcript. The provider receives the supplied messages and applies its own retention policy. Do not include secrets.

Hard local limits:

- 8 active consultations, including pending creation.
- 24 successful user/reply exchange pairs per consultation.
- 16384 UTF-8 bytes per user message or raw advisor reply.
- The pinned advisor model's `contextWindow`, from Pi's model registry. There is no fixed history-byte cap.
- A configured deadline per call, with a 300000 ms default.

Each request asks for at most 4096 output tokens.
Before dispatch, advisor reserves those 4096 output tokens within the model window. Equality passes; overflow returns `context-tokens`.
After validation, the full pair must also fit before commit. No automatic compaction, trimming, or summarization occurs.

Context measurement follows Pi: use the latest positive assistant usage plus Pi's estimates for later messages.
With no positive usage, estimate the fixed system prompt and messages with Pi's public `estimateTokens` helper.
Usage includes cached input and output, including reasoning when reported. It is not cumulative consultation usage or ciphertext length.
The model window is pinned at creation. Missing or invalid window metadata fails before generation.
These are estimates, not exact tokenization or a provider acceptance guarantee. Provider calls may incur charges, including replies rejected by validation. No monetary cap is enforced.

Requests declare no tools and omit `toolChoice` for every provider. Pi controls provider payload construction without an advisor tool-choice override. Tool-call replies still fail validation.

Limits fail closed. The extension never evicts or silently summarizes history.
Limit failures retain `error.code = "limit-exceeded"` and add `error.limit = {resource, maximum, actual}`.
Measurements use UTF-8 bytes, estimated context tokens, or attempted exchange/session counts. Bounds are inclusive.

| Resource | Recovery |
| --- | --- |
| `input-bytes` | Send a shorter message. |
| `reply-bytes` | Request a shorter answer. |
| `context-tokens` or `turns` | Start a new consultation with your own explicit summary. |
| `sessions` | Close idle consultations. |

One request may run per consultation. Overlapping requests and busy close return `busy`. Cancellation and provider failure leave previous exchanges intact. The extension makes no automatic retries. A provider that ignores cancellation can complete later, but its reply cannot change consultation state. Late usage may be unavailable. If a completion attempt produces no observed response, `usageComplete` is false.
A zero usage value with that flag does not mean zero cost. Remote work can continue after local cancellation.
An unavailable model during a completion attempt can also produce incomplete usage. The extension does not infer remote billing from an exception.

Replies must contain nonblank text and finish normally. Empty replies, incomplete completions, malformed content, or tool calls fail with `invalid-response`.
The fixed error message identifies abnormal completion, malformed content, or absent text. Plaintext thinking is removed; only the allowlisted private opaque state above can survive. Public text blocks are joined with a newline without trimming or parsing their contents. Marker-looking strings are ordinary text.
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
npm run packcheck
```

`packcheck` creates a temporary npm archive, checks its file list, extracts it, and loads the extracted package through Pi's resource loader. It requires `tar` on PATH and makes no model requests. Tests and release scripts are not shipped.

Tests use Node's test runner, mock model responses, and private temporary settings directories. TypeScript checks the extension and core. Pi and TypeBox remain host-provided runtime peers.

Verified against Pi 1.0.4 on Node 24, on Linux. Offline tests verify deterministic boundaries and package loading, not reasoning quality or live provider compatibility. Paid provider tests require separate authorization.

## Release checklist

The initial release is `@neruok/pi-advisor@0.1.0`, licensed under MIT. The manifest selects public access on the npm registry.

1. Confirm the release version and regenerate `package-lock.json` after manifest changes with `npm install --package-lock-only --ignore-scripts`.
2. Run `npm ci --ignore-scripts`, `npm run verify`, `npm run packcheck`, and `npm publish --dry-run`. The `prepublishOnly` hook runs verification and the archive check again.
3. Inspect the archive file list and registry name/version availability. Check that the publishing account can publish to the `@neruok` scope without sharing credentials. A dry-run does not establish account permissions.
4. Obtain explicit authorization before committing, tagging, pushing, or running `npm publish`. No automatic release workflow is configured.

The checked archive contains the TypeScript entry point, library modules, README, generated specification, package manifest, and MIT license. Pi supplies the runtime peers; no compilation step is required.

## License

MIT. See [LICENSE](LICENSE).

The specification is generated at `docs/pi-advisor.md` from document `pi-advisor` in the maintainer workspace store. Author through checkout, preview, import, and compile. Do not edit the generated file.
