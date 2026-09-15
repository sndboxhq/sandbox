# sndbox 8 development handoff

Updated: 2026-09-11

## Resume on another computer

```powershell
git fetch origin
git switch feat/version-8-development
git pull --ff-only
npm install
```

The canonical development branch is `feat/version-8-development`. Do not resume from the retired `feat/integrated-desktop-power-user` branch name.

## Current release state

- Product version is `0.8.0-beta.1`; workflow schema is 7 and export format remains 1.
- The desktop command surface is a docked, resizable sndbox-only console. The editor node picker remains on `A`.
- The Rust engine owns the node contract registry, gate states, placement rules, retry safety, and generated frontend contract snapshot.
- Custom `ƒx` nodes use a full-page JavaScript/Python editor, restricted runtimes, fixtures, coverage, SHA-256 verification receipts, and local-desktop placement.
- Executable nodes support fail, error-route, and typed-fallback terminal strategies plus bounded retry/backoff and cancellation.
- Windows integration includes `.sndbox` import staging, legacy import support, drag/drop, quick launcher, global shortcut settings, and opt-in background startup.
- Code/source nodes can connect directly to the Web Builder's HTML, JavaScript, and CSS ports without a merge node.
- Canvas edges and node inputs can be explicitly unlinked from the editor.
- Permission review is contract-aware. Semantic graph edits revoke local approval receipts; layout-only movement does not.
- Live workflow sharing is implemented end to end: the control plane stores server-sequenced ciphertext only, desktop keys live in the OS vault/invite, cross-device bootstrap creates a disabled approval-free local copy, and the editor shows encrypted presence and selections.
- Collaboration OpenAPI request/response schemas are explicit and versioned at 0.8.0.
- The soft announcement artwork is `public/version-8-welcome-v2.png`.

## Last verified gates

- `npm run build` — passed.
- Focused frontend command, collaboration, bootstrap, permission, and dialog tests — 23 passed.
- `npm run test --workspace @sandbox/control-plane` — 111 passed; 13 database tests skipped without `TEST_DATABASE_URL`; OpenAPI drift check passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib` — 35 passed.
- Headless visual QA completed for the dashboard, workflow creation, editor, command console, and collaboration dialog at 1440×900, with a compact dashboard pass at 1100×760.

## Next high-value work

1. Finish authoritative multi-port editing for all built-in contracts. The registry describes named ports, but ordinary editor connections still default to a single `input` handle outside Merge, Web Builder, and custom nodes.
2. Add an optimistic collaboration rebase unit boundary around the editor queue and run true two-client end-to-end tests. Remote edits already reset stale local undo history.
3. Run `collaboration.integration.test.ts` and the other database suites with a migrated `TEST_DATABASE_URL` in CI or a local PostgreSQL instance.
4. Continue visual QA across Settings, Plugins, Cloud, approvals, run history, the full-page `ƒx` editor, and dark/high-contrast themes.
5. Add a packaged-desktop Web Builder test proving three direct source connections start one site with no merge node.
6. Complete Windows 10/11 packaged smoke coverage for file association, running-instance opens, shortcut conflicts, login startup, and uninstall cleanup.
7. Expand command completion and command-state tests as new node/desktop actions are added.

## Guardrails to preserve

- Collaboration invite codes contain encryption keys and must never enter persisted command history, logs, analytics, or control-plane plaintext.
- Synced/shared workflows must never inherit device approvals, runtime enablement, plugin credential references, or custom-node verification receipts.
- Custom functions remain local-only and unverified after import, duplication, or receipt-invalidating changes.
- Command actions must use the same application actions, confirmations, permission checks, validation, unsaved-change handling, and undo behavior as graphical controls.
- Preserve user worktree changes and regenerate `src/generated/node-contracts.json` only through the contract snapshot script.
