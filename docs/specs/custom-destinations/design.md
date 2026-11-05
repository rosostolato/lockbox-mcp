# Custom destinations — design

Version: v0.2-draft · Implements: [`requirements.md`](requirements.md)

## Approach in one paragraph

A custom destination is the only adapter, `CustomDestinationAdapter`, registered under the
id `custom` (the three built-ins are deleted, REQ-020). Its "target" is the agent's JSON definition. `normalizeTarget` validates the
definition against a closed zod schema, canonicalises it (RFC 8785 JSON Canonicalization),
hashes it, resolves anything that can drift (executable real path and binary hash, file
real path), and returns a `NormalizedTarget` that carries the frozen definition. Everything
after that — the snapshot, its digest, Stage A, Stage B, revise, expiry — is the existing
machinery. The UI renders the frozen definition as the operation it describes; the executor
consumes that same object. Saved destinations are a small store keyed by name and pinned
by hash.

## Data model

All types live in `src/custom/definition.ts`. Every string field is bounded; every object
is closed (`.strict()`).

```ts
type CustomDefinition = HttpDefinition | CommandDefinition | FileDefinition;

interface HttpDefinition {
  kind: 'http';
  label: string;                 // ≤ 64 chars, shown as the title
  url: string;                   // https only, ≤ 2048, no placeholder (REQ-004)
  method: 'POST' | 'PUT' | 'PATCH';
  headers: Record<string, string>; // ≤ 32; values may contain {{secret}} (REQ-004)
  body:
    | { type: 'json'; value: JsonValue }  // {{secret}} only as a whole string leaf
    | { type: 'text'; value: string; contentType: string }
    | { type: 'none' };
  reference?: string;            // JSONPath subset `$.a.b[0].c`, ≤ 128 (REQ-005)
}

interface CommandDefinition {
  kind: 'command';
  label: string;
  executable: string;            // absolute path (REQ-006)
  args: string[];                // ≤ 64, no {{secret}} (REQ-006)
  cwd?: string;                  // absolute, defaults to the first allowed root
  stdin: string;                 // template; must contain {{secret}} exactly once
}

interface FileDefinition {
  kind: 'file';
  label: string;
  path: string;                  // resolved inside LOCKBOX_ENV_ALLOWED_ROOTS (REQ-008)
  template: string;              // ≤ 64 KiB, contains {{secret}} exactly once
  mode: 'create' | 'replace';
}
```

Derived at normalization and frozen into `NormalizedTarget.fields` (strings only, as today):

| Field | Kinds | Meaning |
| --- | --- | --- |
| `definition_hash` | all | `sha256(JCS(definition))`, hex |
| `definition_json` | all | the canonical JSON, for display and execution |
| `host` | http | lowercased ASCII host after IDNA (`URL.hostname`) |
| `executable_realpath` | command | `realpath(executable)` |
| `executable_sha256` | command | hash of the binary at approval time |
| `path` / `relative` | file | as in the `.env` adapter |
| `saved_name` | all | set when the definition came from the saved store |

`destinationClass`: `http` → `arbitrary-network`; `command` → new class `local-command`;
`file` → `local-plaintext`. The registry's blanket refusal of `arbitrary-network`
(`src/adapters/registry.ts:23`) becomes "refused unless the adapter is `custom`", whose every
request is high risk and goes through Stage B (REQ-012, REQ-018). That is the SPEC §16
deviation the requirements record.

### Saved store

`$XDG_CONFIG_HOME/lockbox/destinations.json` (fallback `~/.config/lockbox/`), mode `0600`, written
with the `.env` adapter's atomic-write helper.

```json
{ "version": 1,
  "destinations": {
    "vercel-prod": {
      "hash": "9f2c…",
      "definition": { "kind": "http", "…": "…" },
      "approved_at": "2026-10-26T20:41:00Z",
      "executable_sha256": null
    } } }
```

On load, each entry's `hash` is recomputed from `definition`; a mismatch marks the entry
`tampered` and it is treated as unapproved (NFR-005, REQ-014).

## MCP surface

| Tool | Change | REQ |
| --- | --- | --- |
| `secret_store` | `destination` is `"custom"` with a `target.definition` object, or `"saved:<name>"` with no target. Nothing else (REQ-020). Schema stays closed; `definition` has its own closed schema. | 001, 015, 020 |
| `secret_destinations` | Returns the definition schema, the enabled kinds, worked examples (`.env` file, `gcloud` command, an HTTP API) and one entry per saved destination: name, kind, host/path, hash prefix. | 016, 021 |
| `secret_revise` | Unchanged: a new definition is a new authorization. | 014 |

The existing argument screening runs over the whole definition (REQ-003). Errors use
existing codes: `INVALID_TARGET`, `DESTINATION_NOT_PERMITTED`, `UNKNOWN_DESTINATION`.

## Rendering (Stage A and B)

The main screen keeps today's structure (REQ-009): environment band, title "Paste
`STRIPE_SECRET_KEY`", **one destination line**, risk-signal lines, the field, the buttons.

```text
● PRODUCTION · HIGH RISK                         EXPIRES IN 4:59
Paste STRIPE_SECRET_KEY
GOES TO  Vercel env var · api.vercel.com
⚠ First time sending to api.vercel.com
[ ••••••••••••••••••••••••• ]
✓ Looks like a live key · matches production
[ Cancel ] [ Continue ]
▸ See exactly what will be sent
```

The destination line is `label · short target` (host, executable base name or relative
path). Risk signals are one sentence each, above the field (REQ-011). Everything else is in
one closed `<details>` at the bottom of the card (REQ-010), so the screen reads in a glance
and the detail is one click away.

Inside the disclosure, `customReview(request)` renders the operation. One function per kind,
all built from `definition_json` (NFR-002):

- **http** — `POST https://api.vercel.com/v10/projects/acme/env` on one line, the host
  emphasized; a header table; the body pretty-printed with `{{secret}}` shown as a masked
  chip `•••• STRIPE_SECRET_KEY`. Placement is visible at a glance: header vs body.
- **command** — `executable_realpath`, then each argument on its own line (exactly as passed
  to `execFile`, no shell quoting to misread), then "stdin:" and the stdin template with the
  masked chip.
- **file** — absolute path, relative path, and the full template with the masked chip.

Below the rendered view, still inside the disclosure: the canonical JSON and its hash.

Risk-signal wording (main screen): "First time sending to `api.vercel.com`", "Host uses
non-ASCII characters (shown as `xn--…`)", "IP address instead of a host name", "Executable is
outside /usr/bin, /usr/local/bin, /opt/homebrew/bin", "File is outside this project",
"Changed since you saved it".

For a saved destination the destination line reads "Saved · `vercel-prod` ·
api.vercel.com". For a changed one, the "Changed since you saved it" line is on the main
screen and the line diff of the canonical JSON is at the top of the disclosure (REQ-014).

Stage B (always, REQ-012): the typed confirmation phrase is the host (http), the executable
base name (command) or the relative path (file). Two buttons replace one: **Only this time**
(primary) and **Save as trusted destination**, which reveals a name field
(`[a-z0-9-]{1,40}`, prefilled from the label) (REQ-013). With `LOCKBOX_CUSTOM_DESTINATIONS=once`,
only the first is shown.

## Replacing the built-ins (REQ-020, REQ-021)

| Former adapter | Equivalent definition |
| --- | --- |
| `env-file` | `file`: `path: ".env"`, `template: "KEY={{secret}}\n"`. The `.env` hardening moves into the `file` executor (roots, symlinks, git hygiene, atomic `0600`). Merging into an existing `.env` keeps its line-replace logic, selected when the path matches `ENV_FILENAME_PATTERN`. |
| `gcp-secret-manager` | `command`: `/…/gcloud secrets versions add <id> --project <p> --data-file=-`, `stdin: "{{secret}}"`. Uses `gcloud`'s own login; Lockbox no longer needs `google-auth-library`. |
| `firestore` | No CLI writes a single field cleanly; documented as a gap (an `http` definition would need an access token, which this version does not supply). |

Deleted: `src/adapters/gcpSecretManager.ts`, `firestore.ts`, `googleTransport.ts`, their tests
and fakes, and the `google-auth-library` optional dependency. `envFile.ts` helpers move to
`src/custom/file.ts`.

## Execution

`CustomDestinationAdapter.store(secret, target)` re-parses nothing: it reads the frozen
definition from the target.

- **http** — `node:https` with `maxRedirects` 0; DNS resolved once, connection pinned to that
  address with SNI set to the host; refuses loopback, link-local, private and metadata
  addresses unless `LOCKBOX_CUSTOM_HTTP_ALLOW_PRIVATE=true`. JSON bodies are serialized with
  the secret inserted as a JSON string (escaping by `JSON.stringify`, never string
  concatenation). Header values reject a secret containing CR or LF. Success is 2xx. The
  `reference` JSONPath is evaluated on a parsed body capped at 64 KiB; the extracted value
  goes through `safeDisplay`, is cut to 200 chars, and is dropped if the tripwire finds the
  secret in it (REQ-005, NFR-003).
- **command** — re-hash the binary and refuse if `executable_sha256` changed since approval
  (TOCTOU); `execFile(realpath, args, { shell: false, env: minimal, cwd, timeout })`; write
  the rendered stdin from a wipeable buffer and close; discard stdout/stderr after the
  tripwire scan; success is exit 0 (REQ-006, REQ-007).
- **file** — reuse the `.env` adapter's resolve, preflight and `atomicWrite` (REQ-008).

## Threats and how this design answers them

| Threat | Answer | Residual |
| --- | --- | --- |
| Hijacked agent proposes `https://attacker.example` | Review shows the host first, flags "first time"; Stage B makes the human type the host | A human who types what they don't read |
| Lookalike host (`api.verce1.com`, IDN homograph) | Host shown after IDNA as ASCII, non-ASCII flagged, typed confirmation of the exact host | Pure ASCII lookalikes rely on reading |
| Secret smuggled into URL or argv (logged, visible in `ps`) | Schema forbids the placeholder there (REQ-004, REQ-006) | — |
| Redirect to an attacker after approval | Redirects not followed | — |
| DNS rebinding between approval and send | Resolve once at send, pin, refuse private ranges | Approval binds a name, not an address |
| Binary swapped after approval | `executable_sha256` re-checked before exec | Swap between check and exec (narrow) |
| Response echoes the secret back to the agent | Only status and a tripwire-checked reference are returned | — |
| Agent edits `destinations.json` to change a saved destination | Hash recomputed on load; mismatch = unapproved | An agent with a shell can rewrite both entry and hash; documented (out of scope) |
| Approval fatigue from repeated reviews | "Save as trusted" for stable destinations | Saved destinations still show a compact review each time |

## File structure

```text
src/
  custom/
    definition.ts      # zod schemas, types, canonicalization, hashing
    render.ts          # masked rendering + risk signals (pure, unit-testable)
    http.ts            # HTTP executor (pinned DNS, no redirects)
    command.ts         # command executor (stdin only, minimal env)
    store.ts           # saved destinations: load, verify, save, remove
  adapters/
    custom.ts          # CustomDestinationAdapter (normalize, preflight, risk, store)
  ui/render.ts         # customReview(), Stage B two-button variant
test/
  custom/              # definition, render, http, command, store unit tests
  security/custom/     # canary, lookalike host, redirect, rebinding, tamper tests
```

## Open questions

- **Authenticated HTTP APIs.** Most APIs (Vercel, Doppler, GitHub) need a token in the
  request besides the credential being stored. The agent must not supply it, and REQ-002
  forbids other placeholders. Options for a later version: (a) a second human-entered value
  per definition (`{{auth}}`), typed in the same window; (b) a reference to a token Lockbox
  already stores from an earlier request. Until then, the `command` kind with the provider's
  CLI covers these.
- Firestore has no clean CLI path; accept the gap, or keep a minimal built-in until (a)
  above exists?
- Command kind and the identity of the binary: is hashing the executable enough, or should
  approval also pin its code signature on macOS?
- Should Lockbox ship a few vetted example definitions (Vercel, Doppler, GitHub Actions) in
  `secret_destinations`, or only in the README? Draft: both, as examples the agent adapts.
