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

## Consultation tools

Start:

```json
{ "message": "Objective: fix the timeout. My understanding: workers wait for a queue signal. Evidence: the queue contains work, but no worker wakes. Constraint: preserve shutdown behavior. Uncertainty: signal loss or lock contention? What should I test?" }
```

`advisor` returns a session identifier, response, status, committed exchange count, pinned model, per-call usage, and cumulative usage.

Continue through `advisor`:

```json
{ "session": "adv_<returned-id>", "message": "I traced the signal. It fires before the worker begins waiting. How can I distinguish a lost wakeup from a stale predicate?" }
```

`advisor_sessions({})` lists identifiers and metadata, not transcripts. Finish with `advisor_close({"session":"adv_<returned-id>"})`.

Statuses are `continue`, `actionable`, `approval_needed`, or `exhausted`. None automatically closes a consultation or executes advice.

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

Limits fail closed. The extension never evicts or silently summarizes history. Close unused sessions or start a new consultation with your own explicit summary.

One request may run per consultation. Overlapping requests and busy close return `busy`. Cancellation and provider failure leave previous exchanges intact. The extension makes no automatic retries. A provider that ignores cancellation can complete later, but its reply cannot change consultation state. Late usage may be unavailable.

Replies must end with exactly one final protocol marker. Missing markers, incomplete replies, or tool calls fail with `invalid-response`. Errors omit raw provider messages.

Settings locks coordinate participating writers. An unrelated writer can still race between the final byte comparison and replacement. Parent-directory races and provider code remain outside an operating-system sandbox.

## Development

```sh
npm ci --ignore-scripts
npm run verify
```

Tests use Node's test runner, mock model responses, and private temporary settings directories. TypeScript checks the extension and core. Pi and TypeBox remain host-provided runtime peers.

Verified against Pi 1.0.4 on Node 24, on Linux. Offline tests verify deterministic boundaries and package loading, not reasoning quality or live provider compatibility. Paid provider tests require separate authorization.

The specification is generated at `docs/pi-advisor.md` from document `pi-advisor` in the maintainer workspace store. Author through checkout, preview, import, and compile. Do not edit the generated file.
