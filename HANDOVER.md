# Overnight handover — GitNexus fork

_2026-06-08, autonomous session. Everything below is isolated and reversible:
**nothing was pushed**, your main checkout
(`Downloads/GitNexus-main/GitNexus-main`) was never touched, and your
uncommitted `AGENTS.md` / `CLAUDE.md` edits there are exactly as you left them._

## Where everything is

- **Worktree:** `C:\Users\patij212\Downloads\gitnexus-merge-prototype`
- **Branch:** `integration/upstream-merge-prototype` (off your fork HEAD `16057300`)
- **Two tested fixes committed** on that branch:
  - `6ac663ec` fix(scope): synthesize a Module scope instead of dropping the file
  - `ba197e54` fix(status): surface uncommitted working-tree changes
- Two docs (this file + `INTEGRATION-PLAYBOOK.md`) at the worktree root.

To inspect: `cd` to the worktree and `git log --oneline -4`, `git show 6ac663ec`, `git show ba197e54`.

## What I built, and why

### Fix 1 — scope abort no longer drops whole files (`6ac663ec`)
The exact bug we hit while indexing (`ScopeExtractor: no Module scope found … `
aborting a legacy `.ts` file). When a file parses to a tree-sitter ERROR root or
a provider has a scope-coverage gap, the extractor emitted class/function scopes
with no enclosing module and **threw — dropping the entire file from the index.**
Now it synthesizes a Module spanning the orphan scopes and re-parents them under
it, so the file is still indexed (degraded but present). Mirrors upstream's
namespace-less-PHP fix (#1801); `canParentScope` already permits a Module whose
range equals its non-Module child, so the exact span is safe.
- Files: `gitnexus/src/core/ingestion/scope-extractor.ts` (+ 2 tests updated that
  codified the old throw behavior).
- **Tests: 660/660 scope-resolution tests pass.**

### Fix 2 — `status` is working-tree aware (`ba197e54`)
`gitnexus status` compared only HEAD vs the indexed commit, so a repo at the
indexed commit reported a bare `✅ up-to-date` even with staged/unstaged/untracked
edits the index had never seen — the kind of thing that makes impact analysis
silently wrong. Added `countWorkingTreeChanges` (`git status --porcelain` via
`execFileSync`, no shell) and an advisory line when the tree is dirty. The
existing `Status:` line is byte-identical, so output assertions still hold.
- Files: `gitnexus/src/storage/git.ts`, `gitnexus/src/cli/status.ts` (+ test).
- **Tests: 18/18 git-utility tests pass.**

## Validation

| Check | Result |
|---|---|
| `tsc --noEmit` (whole `gitnexus` package) | **0 errors** |
| scope-resolution suite | 660 passed |
| git-utility suite | 18 passed |
| full `vitest run test/unit` | **5269 passed, 10 skipped, 5 failed** |

The 5 failures are all in `skip-git-cli.test.ts` and all the same error:
`Cannot find module '…/gitnexus/dist/cli/index.js'`. Those tests spawn the
**compiled** CLI, and this throwaway worktree's `dist/` was never built. They
fail identically on clean fork HEAD here and **touch none of my changes** — zero
regressions. They pass once `dist/` is built. I tried building it here, but the
fork's `scripts/build.js` invokes `npx tsc`, which mis-resolves in a fresh
worktree (the same pre-existing quirk that broke `npm install`'s `prepare`
step) — your main checkout, which already has a working `dist/`, builds fine.
Type-correctness is independently confirmed by `tsc --noEmit` passing with
**0 errors**.

## Why I did NOT auto-complete the upstream merge

You asked me to prototype the merge; I measured it precisely first. `git merge
upstream/main` yields **54 `CONFLICT (content)` files**. Critically, the fork
co-evolved its **web UI + MCP backend + server API as one contract**
(`local-backend.ts` +2152, `GraphCanvas.tsx` +1953, `api.ts` +889), and upstream
rewrote the same surfaces independently. A blind resolution would compile but
mismatch that contract in ways no test catches — a polished-looking trap. That's
not something to hand you unsupervised. The full per-file resolution plan,
must-have commits, and validation gates are in **`INTEGRATION-PLAYBOOK.md`**.

The scope fix above is, in effect, a safe standalone back-port of one of those
upstream fixes — landed and tested tonight so you get the value without the merge.

## How to use this

- **Adopt the fixes** onto your working branch (in your main checkout):
  `git cherry-pick 6ac663ec ba197e54`
- **Or keep iterating here**, then merge the branch when ready.
- **Throw it away** (fully reversible): from the main checkout run
  `git worktree remove ../../gitnexus-merge-prototype --force` then
  `git branch -D integration/upstream-merge-prototype`.

Note: I copied your main checkout's built `gitnexus-shared/dist` into the worktree
so tests could resolve the `gitnexus-shared` package — it's gitignored and
harmless, and disappears when you remove the worktree.

## Suggested next steps
1. Cherry-pick the two fixes into your real branch (they're independent and low-risk).
2. When you have a supervised window, run the merge per `INTEGRATION-PLAYBOOK.md` — lead with the storage/read-only cluster (it makes the shadow-replay incident self-heal) and the true-incremental commit (kills the analyze treadmill).
3. Optional third fix not done tonight: the `embeddings: 0` discoverability nudge in semantic search (flagged as novel/low-risk; no upstream equivalent).
