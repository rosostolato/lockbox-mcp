# Custom destinations — tasks

Implements: [`requirements.md`](requirements.md) · [`design.md`](design.md)

Each task ends with its scoped test command. The full suite (`npm run check`) runs once at
the end of each phase.

## Phase 1 — Definition and configuration

Goal: Lockbox can parse, validate, canonicalize and hash a definition, and the operator can
turn the feature on.

- [x] **TASK-001** [REQ-018, REQ-019] Add `customDestinations` (`save|once`, default `save`),
  `customKinds`, `customHttpHosts`, `customHttpAllowPrivate` to `LockboxConfig` and
  `configFromEnv`. *Verify:* `npx vitest run test/units.test.ts`.
- [x] **TASK-002** [REQ-001, REQ-002, REQ-003, REQ-004, REQ-006, REQ-008, NFR-004] Zod schemas
  for the three kinds in `src/custom/definition.ts`, closed objects, bounds, placeholder
  rules, credential screening, `{{secret}}` exactly once.
  *Verify:* `npx vitest run test/custom/definition.test.ts` (valid fixtures pass; each
  forbidden placement, scheme, method and expansion is refused).
- [x] **TASK-003** [NFR-002, REQ-014] RFC 8785 canonicalization and `definitionHash()`.
  *Verify:* same file; key order and whitespace do not change the hash; one character does.

## Phase 2 — Adapter and MCP surface

Goal: `secret_store` accepts a custom definition and the snapshot carries it frozen.

- [x] **TASK-004** [REQ-001, REQ-003, REQ-012, REQ-019] `CustomDestinationAdapter.normalizeTarget`,
  `calculateRisk` (always high), kind and host allowlists, registry accepts
  `arbitrary-network` only for `custom`.
  *Verify:* `npx vitest run test/custom/adapter.test.ts`.
- [x] **TASK-005** [REQ-006] Resolve `executable_realpath` and `executable_sha256` at
  normalization. *Verify:* same file; a relative path and a missing binary are refused.
- [x] **TASK-006** [REQ-001, REQ-015, REQ-016] `secret_store` schema: `custom` with
  `target.definition`, `saved:<name>`; `secret_destinations` listing with examples.
  *Verify:* `npx vitest run test/mcpProtocol.test.ts test/custom/adapter.test.ts`.

## Phase 3 — Review UI

Goal: a glance tells what to paste and where it goes; one click shows exactly what is sent.

- [x] **TASK-007** [REQ-009] Main-screen destination line (`label · host/executable/path`) in
  the existing Stage A layout. *Verify:* `npx vitest run test/custom/render.test.ts`.
- [x] **TASK-007b** [REQ-010] Closed "See exactly what will be sent" disclosure: masked
  rendering per kind, canonical JSON and hash. *Verify:* same file (the canary never
  appears; `<details>` has no `open`).
- [x] **TASK-008** [REQ-011] Risk-signal lines on the main screen: first-time host,
  non-ASCII/punycode, IP literal, executable location. *Verify:* same file, one fixture per
  signal. "Changed since saved" lands with TASK-015; "file outside project" was dropped,
  because a `file` path is always inside an allowed root by construction.
- [x] **TASK-009** [REQ-012] Stage B for custom: typed phrase (host / executable name /
  relative path), "Send to …" / "Save to …". *Verify:* `npx vitest run test/custom
  test/security/ui`. The "Save as trusted destination" button moves to TASK-014, so no
  button ships before the store that backs it.
- [x] **TASK-010** [NFR-006] Check the review at 420 px in the real browser (preview script).
  *Verify:* http and command pages, disclosure open and closed, `scrollWidth` = 420.

## Phase 4 — Executors

Goal: each kind sends the credential exactly as reviewed and nowhere else.

- [x] **TASK-011** [REQ-004, REQ-005, NFR-003] HTTP executor: no redirects, pinned DNS,
  private ranges refused, JSON-safe insertion, header CR/LF refusal, reference extraction.
  *Verify:* `npx vitest run test/custom/http.test.ts` against a local TLS test server.
- [x] **TASK-012** [REQ-006, REQ-007, NFR-003] Command executor: stdin only, minimal env,
  binary hash re-check, timeout + SIGKILL, output discarded after tripwire.
  *Verify:* `npx vitest run test/custom/command.test.ts`.
- [x] **TASK-013** [REQ-008] File executor reusing the `.env` helpers.
  *Verify:* `npx vitest run test/custom/file.test.ts test/envAdapter.test.ts`.

## Phase 5 — Saved destinations

Goal: approve once, reuse safely, notice any change.

- [x] **TASK-014** [REQ-013, REQ-014, NFR-005] `src/custom/store.ts`: load with hash
  verification, atomic save, remove; "Save as a trusted destination" at Stage B, saved only
  after a successful write. *Verify:* `npx vitest run test/custom/store.test.ts`.
- [x] **TASK-015** [REQ-014, REQ-015] "Changed since you saved it" signal; "Saved · name"
  destination line; known hosts no longer "first time". No diff (see REQ-014).
  *Verify:* same file.
- [x] **TASK-016** [REQ-017] Forget a saved destination from the window that uses it.
  *Verify:* same file.

## Phase 6 — Retire the built-ins

Goal: custom definitions are the only way, and nothing a user relied on silently disappears.

- [x] **TASK-021** [REQ-020] Update SPEC §16 and §17 to record the deviation (custom on by
  default, always Stage B) and the removal of built-in adapters.
  *Verify:* `npx prettier --check SPEC.md`.
- [x] **TASK-022** [REQ-020] Move `.env` merge and hardening into `src/custom/localFile.ts`
  (file mode `env`); delete `gcpSecretManager.ts`, `firestore.ts`, `googleTransport.ts`,
  their tests and fakes; drop `google-auth-library`; port the env suite to
  `test/custom/envfile.test.ts`. *Verify:* `npx vitest run test/custom test/security`.
- [x] **TASK-023** [REQ-021] README: replace the adapter table with example definitions
  (`.env` file, `gcloud` command, an HTTP API), each checked by `parseDefinition` in a test;
  retake the screenshots. *Verify:* `npx vitest run test/custom/examples.test.ts`.

## Phase 7 — Adversarial suite and docs

Goal: the new surface is held to the same bar as the rest of Lockbox.

- [x] **TASK-017** [NFR-001] Canary suite over all three kinds (MCP traffic, logs, argv, URLs,
  temp files). *Verify:* `npx vitest run test/security/custom`.
- [x] **TASK-018** [REQ-004, REQ-005, REQ-011] Malicious-definition fixtures: attacker host,
  homograph, redirect, secret in URL/argv, response echo, metadata address, markup/bidi in
  labels. (DNS rebinding is covered by design — one lookup, pinned — but not by a test: it
  needs a controllable resolver.)
  *Verify:* same directory.
- [x] **TASK-019** [REQ-018] README section "Custom destinations", configuration rows,
  `SECURITY_MODEL.md` traceability rows, SPEC §16 note.
  *Verify:* `npx prettier --check README.md docs`, links resolve.
- [x] **TASK-020** [all] Full check. *Verify:* `npm run check` and one manual end-to-end run
  per kind in the browser.
