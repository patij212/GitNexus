# GitNexus fork → upstream merge playbook

_Generated 2026-06-08 from a measured dry-run merge. The fork
(`patij212/GitNexus`) is **305 commits behind** `upstream/main`
(`abhigyanpatwari/GitNexus`); last common commit (merge-base) is
`4cd3ee38` (2026-05-07). The fork carries 18 commits / ~184 changed files
upstream lacks (the "NexusForge" customization: web renderer + MCP backend +
server API)._

## TL;DR

- A **full `git merge upstream/main` produces 54 conflicts, all `CONFLICT (content)`** (measured with `git merge-tree` and confirmed with a real in-worktree merge). No modify/delete or add/add tangles.
- The fixes for **every problem observed in production** (read-only shadow-replay abort, the ~9.5-min analyze treadmill, the `no Module scope found` abort, Windows FTS) live in upstream and are **not independently cherry-pickable** — they ride a tightly-coupled `lbug` storage cluster + an all-or-nothing scope-resolution rewrite. A full merge pulls them as dependent units.
- **The hard part is not breadth, it's coupling.** The fork co-evolved web UI + MCP backend + server API as one contract; upstream rewrote the same surfaces independently. A blind "take-upstream backend + take-ours web" split would compile but mismatch the contract. The ~5 renderer files + 4 storage files + `local-backend.ts`/`api.ts` are the only files that need real human judgment; the rest are mechanical.

## Strategy

**Recommended: full merge, resolve once, on a throwaway branch, gated by tests.**
Rebasing the 18 fork commits is strictly worse — the snapshot-import commits
re-touch backend files upstream rewrote, forcing repeated conflict resolution.

Sequence:

1. Tag current fork HEAD; confirm the web-perf fidelity gates are green as the acceptance baseline (`graph-perf`, `graph-render-model`, `sigma-visual-cache` tests).
2. `git merge upstream/main`. Most of the 1,501 upstream-changed files auto-merge.
3. Resolve the 54 conflicts using the per-file rules below.
4. `npm install` in `gitnexus/`, `gitnexus-web/`, `gitnexus-shared/` to regenerate lockfiles; build (`npm run build`) and run the unit suites.
5. **Accept one cold reindex**: incremental indexing (`4fa40e98`) bumps `PARSE_CACHE_VERSION`, so the first post-merge `analyze` is a full run for every repo.
6. Run the web-perf fidelity gates; manually smoke-test the app (the MCP↔web contract is the highest semantic risk).
7. Re-validate a real Windows `analyze` (upstream's retire-don't-terminate worker pool supersedes the fork's terminate guard).

## The 54 conflicts — resolution rules

Magnitudes are `ours(+lines)/theirs(+lines)` vs the merge base.

### A. Take upstream wholesale (fork delta is superseded or minor)
The storage cluster here is what fixes the read-only shadow-replay incident.

| File | o/t | Why upstream wins |
|---|---|---|
| `core/lbug/lbug-config.ts` | 6/527 | WAL checkpoint threshold (64 MiB) + Windows non-ASCII path + corruption detection. Fork hardcodes the 7th `Database()` arg to `-1`. |
| `core/lbug/lbug-adapter.ts` | 344/768 | Replaces the homegrown shadow-replay with the tested `sidecar-recovery.ts` path. **Discard the fork's NexusForge shadow code.** |
| `core/lbug/pool-adapter.ts` | 185/221 | Same storage cluster; imports `sidecar-recovery.ts`. |
| `core/ingestion/workers/worker-pool.ts` | 18/1598 | Retire-don't-terminate rewrite (#1833/#1741); supersedes the fork's `process.platform!=='win32'` terminate guard. |
| `core/run-analyze.ts` | 188/571 | **True incremental indexing** (`4fa40e98`). Drop the fork's planning-only `incremental/invalidation.ts`. |
| `cli/analyze.ts` | 112/934 | Repair-FTS + heap + incremental flags. Re-check any fork-only flags. |
| `cli/ai-context.ts` | 8/232 | Upstream rework; fork delta minor. |
| `cli/serve.ts` | 3/39 | Upstream rework; fork delta minor. |
| `core/ingestion/pipeline.ts` | 17/92 | Scope-resolution pipeline. |
| `types/pipeline.ts` | 3/7 | Type follows pipeline. |
| `core/group/extractors/http-route-extractor.ts` | 1/145 | Upstream HTTP route work. |
| `core/group/extractors/http-patterns/types.ts` | 10/50 | Same. |
| `gitnexus-web/src/lib/lucide-icons.tsx` | 3/62 | Icon set; take upstream, re-add any fork-only icons. |

### B. Take ours, then re-apply upstream's small delta by hand
Fork is the primary author; upstream's change is small but may be a needed
signature/i18n update — apply it on top, don't drop it.

| File | o/t | Note |
|---|---|---|
| `gitnexus-web/src/components/GraphCanvas.tsx` | 1953/105 | Fork rewrite; graft upstream's i18n (#1748) + any prop changes. |
| `gitnexus-web/src/components/StatusBar.tsx` | 240/9 | Take ours. |
| `gitnexus-web/src/lib/constants.ts` | 355/7 | Take ours; merge upstream's 7 lines. |
| `gitnexus-web/src/components/FileTreePanel.tsx` | 225/32 | Take ours; graft upstream. |
| `gitnexus-web/src/App.tsx` | 245/19 | Take ours; graft upstream. |
| `gitnexus-web/src/components/RightPanel.tsx` | 236/24 | Take ours; graft upstream. |
| `gitnexus-web/src/hooks/app-state/graph.tsx` | 44/14 | Take ours; graft upstream. |
| `cli/index.ts` | 252/83 | Fork registered commands; re-apply upstream's new command wiring. |
| `core/group/extractors/grpc-patterns/node.ts` | 152/33 | Fork gRPC work; graft upstream. |

### C. Hand-merge — both sides substantial (highest effort / risk)

| File | o/t | Note |
|---|---|---|
| `gitnexus-web/src/hooks/useSigma.ts` | 602/1004 | **THE renderer.** Take upstream's Tree/Circles rewrite (#1799) as base, re-apply the fork's perf deltas (bitset filtering, shared render model, visual cache, dpr/picking gating). Gate on the perf tests. |
| `gitnexus-web/src/lib/graph-adapter.ts` | 250/288 | Reconcile adapter shape against upstream #1799. |
| `gitnexus-web/src/hooks/useAppState.tsx` | 210/98 | App-state contract; reconcile. |
| `gitnexus/src/mcp/local/local-backend.ts` | 2152/858 | **Coupled with the web UI.** Fork heavily customized; upstream changed pagination/#2049/#2067. Hand-merge with the web client in mind. |
| `gitnexus/src/server/api.ts` | 889/219 | Read-only API + endpoints; coupled with web fetchers. |
| `gitnexus/src/mcp/server.ts` | 220/68 | Hand-port the server half of #2049/#2067/#1753. |
| `core/group/sync.ts` | 36/92 | Group sync; reconcile. |
| `core/group/extractors/http-patterns/{java,python}.ts` | 127/679, 356/807 | Both rewrote route detection; reconcile. |
| `core/lbug/csv-generator.ts` | 206/38 | Fork added 206 lines — **audit what the fork added before taking upstream**; storage CSV emit. |
| `gitnexus-shared/src/graph/types.ts`, `pipeline.ts` | small | Reconcile shared contracts first (everything depends on them). |

### D. Mechanical / regenerate
- `gitnexus/package-lock.json`, `gitnexus-web/package-lock.json`, both `package.json`: **don't hand-merge** — accept upstream `package.json`, re-add fork-only deps, then `npm install` to regenerate the lockfiles.
- `README.md`, `AGENTS.md`, `CLAUDE.md`: union or regenerate (`CLAUDE.md`/`AGENTS.md` are partly analyze-generated).
- Small both-sided UI: `EmbeddingStatus.tsx`, `Header.tsx`, `LoadingOverlay.tsx`, `ProcessesPanel.tsx`, `RepoLanding.tsx`, `ToolCallCard.tsx`, `docker-server.mjs(.test)`, `.github/workflows/pr-labeler.yml`, `core/ingestion/pipeline-phases/index.ts` — quick content merges.
- Test files (`calltool-dispatch.test.ts` 321/818, `group/http-route-extractor.test.ts` 214/2574, `server-connection.test.ts`, `filter-panel.test.ts`): prefer upstream, re-add fork-specific cases.

## Must-have upstream commits (lead with these)

Storage/read-only/FTS (fixes today's incident):
`#1784` a8a8a371 · `#1747` a9fef2c6 · `#1772` 87b91c82 · `#1622` a26ac55f ·
`#1650` dfbe68ad · `#1720` (analyze --repair-fts) f350ae27 · `#1655` 7d500390

Parser/scope (fixes `no Module scope found` — note: a minimal back-port of this
already exists on this branch, see HANDOVER.md):
`#1433` d69eadfb · `#1801` 1c499325 · the RFC #909 scope-resolution migration

Performance (fixes the treadmill + worker-idle-timeout split):
`4fa40e98` (true incremental) · `#1918` d1d2a64d · `#1915` f5915ca9 · `#1657` c30833fa

Windows / MCP:
`#1794` 39e9b401 · `#1837` 5e012c37 · `#1729` d3de5fa5 · `#2049` 22304cd4 · `#2040` 93e04b46

## Validation gates (do not declare done until all pass)
1. `npm run build` (gitnexus + gitnexus-web + gitnexus-shared).
2. `vitest run test/unit` — baseline before merge, equal-or-better after.
3. Web-perf fidelity gates green (the fork's load-bearing value).
4. A real `analyze` on a Windows repo (e.g. `thruster_test_station`) — verify the read-only replay error, the scope abort, and the treadmill are all resolved.
5. Manual app smoke test (MCP↔web contract).

## How this was measured
`git merge-tree --write-tree HEAD upstream/main` (in-memory, zero side effects)
→ 54 `CONFLICT (content)` files; reproduced by a real `git merge` in this
worktree, then `git merge --abort`. Per-file magnitudes from
`git diff --numstat <merge-base> {HEAD,MERGE_HEAD} -- <file>`.
