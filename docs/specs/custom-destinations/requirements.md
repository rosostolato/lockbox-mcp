# Custom destinations — requirements

Version: v0.2-draft · Status: proposed · Parent spec: [`SPEC.md`](../../../SPEC.md)

## Summary

Today an agent can only choose one of three built-in destinations (`gcp-secret-manager`,
`env-file`, `firestore`). This feature **replaces them**: every destination is one the agent
**describes** in a JSON definition — an HTTP request, a local command or a templated local
file — and the **human approves** in Lockbox's window before the credential is sent. An approved
definition can be used once or saved as a trusted destination, pinned to its content hash.

The window stays as quick to read as it is today: the main screen shows what to paste, where
it goes in one line, and any warning. The full rendered operation and the raw JSON sit behind
one disclosure the human opens to verify.

**Deviation from SPEC §16.** SPEC requires `arbitrary-network` destinations to be disabled by
default. With no built-in destinations left, this feature is the product, so it is on by
default; the guard moves from "off" to "always reviewed, always Stage B, operator can narrow
kinds and hosts". SPEC §16 and §17 are updated by TASK-021.

The rule that keeps this safe is the same one Lockbox already follows: the agent proposes, the
human authorizes what is shown, and what is shown is exactly what executes. The agent may
write a malicious definition; it must not be able to make the human approve something
different from what they read.

## Actors

- **Agent** — the LLM client calling Lockbox's MCP tools. Assumed compromisable (SPEC §18).
- **Human** — the person at the keyboard, using Lockbox's window.
- **Operator** — whoever sets Lockbox's environment. Often the same person as the human.

## Functional requirements

### Definition

- **REQ-001** The agent shall be able to submit a destination definition as a JSON object
  of one of three kinds: `http`, `command`, `file`.
  *Acceptance:* `secret_store` with `destination: "custom"` and a valid `definition` creates
  a request; an unknown `kind` is refused with `INVALID_TARGET`.
- **REQ-002** A definition shall carry the credential only through the placeholder
  `{{secret}}`, and no other expansion (no environment variables, no `$(...)`, no other
  placeholders except `{{name}}`, the logical credential name).
  *Acceptance:* a definition containing `${HOME}`, `$(id)` or `{{env.X}}` is refused; the
  rendered request contains the value exactly where `{{secret}}` was.
- **REQ-003** A definition shall be refused if any of its fields already contains a
  credential-shaped value (the existing argument screening).
  *Acceptance:* a definition with a header `Authorization: Bearer sk_live_…` literal is
  refused before a request is created.
- **REQ-004** An `http` definition shall allow only `https://` URLs, a method from
  `POST`, `PUT`, `PATCH`, and `{{secret}}` only in the request body or in a header value —
  never in the URL, path or query.
  *Acceptance:* `http://`, a placeholder in the URL, and `GET`/`DELETE` are each refused.
- **REQ-005** An `http` destination shall not follow redirects and shall return to the agent
  only the HTTP status class and an optional non-secret reference extracted by a JSONPath the
  definition declares.
  *Acceptance:* a 302 response fails the request; the agent's result never contains the
  response body.
- **REQ-006** A `command` definition shall name an executable by absolute path plus a fixed
  argument list, run without a shell, and deliver the credential **only on standard input**.
  *Acceptance:* `{{secret}}` in `argv` is refused; a relative executable path is refused; the
  canary never appears in any spawned argv.
- **REQ-007** A `command` destination shall run with a minimal environment (`PATH`, `HOME`,
  `LANG` only), a fixed working directory, and a timeout, and shall return to the agent only
  the exit status.
  *Acceptance:* the child cannot read a variable set only in Lockbox's environment; output is
  never returned through MCP.
- **REQ-008** A `file` definition shall write a template containing `{{secret}}` to a path
  inside `LOCKBOX_ENV_ALLOWED_ROOTS`, with the same protections as the `.env` adapter (no
  symlinks, no traversal, atomic `0600` write, git-tracked refused, new file must be
  git-ignored).
  *Acceptance:* the existing `.env` hardening tests pass against a `file` definition.

### Review and approval

- **REQ-009** The main screen shall keep today's glanceable layout: the task as the title
  ("Paste STRIPE_SECRET_KEY"), **one destination line**, the field and the primary button.
  The destination line is the definition's label plus its short target: the host for `http`
  (`Vercel env var · api.vercel.com`), the executable name for `command`
  (`gcloud secret version · gcloud`), the relative path for `file`.
  *Acceptance:* a Stage A page for each kind fits in the window at 420 px with the
  disclosure closed, and contains no header, argument or template text outside it.
- **REQ-010** The full operation shall sit behind one disclosure, **closed by default**,
  labelled "See exactly what will be sent". Opened, it shows the definition rendered as the
  operation (for `http`: method, full URL, every header and the body; for `command`: the
  resolved executable, each argument and the stdin template; for `file`: the absolute path
  and the full content), each with the credential masked, followed by the raw canonical
  JSON and its hash.
  *Acceptance:* the disclosure is a closed `<details>` on load; opened, its rendered view and
  JSON derive from `definition_json`; the canary never appears.
- **REQ-011** Risk signals shall appear **on the main screen**, one short line each, without
  opening the disclosure: a host never approved before, a non-ASCII or punycode host, an
  IP-literal host, an executable outside standard system directories, a file path outside
  the project, and "changed since you saved it".
  *Acceptance:* each signal has a fixture definition that renders its line above the field.
- **REQ-012** Every custom destination shall be classified **high risk** and require Stage B
  (typed confirmation) regardless of other inputs.
  *Acceptance:* no custom request reaches `EXECUTING` without a Stage B confirmation.
- **REQ-013** At Stage B the human shall be able to tick **"Save as a trusted destination"**
  and name it; the entry is saved only if the write succeeds.
  *Acceptance:* both choices store the credential; only a ticked box with a valid name
  creates a saved entry, and a failed write saves nothing.
- **REQ-014** A saved destination shall be pinned by the SHA-256 of its canonical JSON. Any
  change, however small, shall be treated as a new, unapproved definition.
  *Acceptance:* changing one character of a saved definition makes the next request show
  "changed since you saved it" on the main screen and drop the "Saved" label. (No diff: the
  approved content is not kept apart from the file that was edited, so there is nothing
  trustworthy to diff against.)
- **REQ-015** The agent shall be able to reference a saved destination by name.
  *Acceptance:* `secret_store` with `destination: "saved:vercel-prod"` uses the saved
  definition; the destination line reads "Saved · vercel-prod · api.vercel.com".
- **REQ-016** `secret_destinations` shall list saved destinations by name, kind, host or path
  and hash prefix, and shall never list the template body.
  *Acceptance:* the listing for a saved `http` destination shows `https://api.vercel.com`,
  not its headers or body.
- **REQ-017** The human shall be able to remove a saved destination from Lockbox's window.
  *Acceptance:* after removal, `saved:<name>` is refused with `UNKNOWN_DESTINATION`.

### Built-in destinations

- **REQ-020** The built-in adapters `gcp-secret-manager`, `env-file` and `firestore` shall be
  removed. `secret_store` shall accept only `destination: "custom"` with a definition, or
  `destination: "saved:<name>"`.
  *Acceptance:* `destination: "env-file"` is refused with `UNKNOWN_DESTINATION` and a message
  pointing to custom definitions; `google-auth-library` is no longer a dependency.
- **REQ-021** The README shall show, for each former built-in, the equivalent definition:
  `.env` as a `file` definition, Google Secret Manager as a `command` definition running
  `gcloud secrets versions add … --data-file=-`, and Firestore as a `command` definition or
  a documented gap.
  *Acceptance:* each example passes `parseDefinition` in a test.

### Operator control

- **REQ-018** Destinations shall be available by default. `LOCKBOX_CUSTOM_DESTINATIONS` shall
  take `save` (default: the human may save) or `once` (every request is approved on its
  own); any other value falls back to `once`.
  *Acceptance:* with the default configuration the Stage B page offers both "Only this time"
  and "Save as trusted destination"; with `once`, only the first.
- **REQ-019** The operator shall be able to restrict kinds with `LOCKBOX_CUSTOM_KINDS`
  (comma-separated subset of `http,command,file`) and HTTP hosts with
  `LOCKBOX_CUSTOM_HTTP_HOSTS` (allowlist; empty means any host, still reviewed).
  *Acceptance:* a definition outside either list is refused before a request is created.

## Non-functional requirements

- **NFR-001 Confidentiality.** Every SEC-001…SEC-010 invariant (SPEC §19–§24) holds for all
  three kinds; the canary suite runs against each kind.
- **NFR-002 Display ≡ execution.** The rendered review, the hashed canonical JSON and the
  executed operation derive from one deep-frozen object; there is no second parse.
- **NFR-003 Bounded execution.** HTTP: connect + total timeout ≤ `LOCKBOX_ADAPTER_TIMEOUT_SECONDS`;
  response read capped at 64 KiB. Command: same timeout, then `SIGKILL`; output capped at
  64 KiB and discarded after the tripwire scan.
- **NFR-004 Size limits.** Canonical definition ≤ 16 KiB; ≤ 32 headers; ≤ 64 argv entries;
  template ≤ 64 KiB.
- **NFR-005 Saved-store integrity.** The saved-destination file is written only by Lockbox,
  mode `0600`, atomically, and each entry carries the hash it was approved under.
  Tampering that changes a definition is detected as "changed since you saved it".
- **NFR-006 Review legibility.** The rendered review of a typical definition (one URL, ≤ 4
  headers, JSON body) fits in the window without horizontal scroll at 420 px width.

## Out of scope (this version)

- Destinations that **read** a credential back, or rotate one.
- OAuth flows or any interactive login performed by Lockbox for the destination.
- Placeholders other than `{{secret}}` and `{{name}}`; templating logic (conditionals,
  loops, encodings beyond JSON/header/raw).
- Sharing saved destinations between machines or users.
- Protecting the saved-destination file from an agent with an unrestricted shell running
  as the same user (documented limit; see design §Threats).
- `GET`/`DELETE` HTTP methods, plain `http://`, following redirects.
- Built-in presets (Vercel, Doppler, GitHub Actions…). They can come later as example
  definitions in the README.
- A second credential for authenticating an `http` destination (an API token the request
  itself needs). In this version authenticated APIs are reached through their CLI with the
  `command` kind, which uses the CLI's own login. See design § Open questions.
