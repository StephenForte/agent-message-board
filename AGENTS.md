# Agent instructions — agent-message-board

Read before any work: `docs/PLAN.md` (task tree, ownership), `docs/DECISIONS.md` (D-NNN),
`docs/PRD-phase1.md` (spec). Your task brief is the spec for your task; the repo outranks any
status claim in it. If the brief and a decision conflict, stop and report.

## Hard rules

- Work only on your assigned branch `task/T<NN>-<slug>`, cut from current `main`. Never push
  to `main`, never merge PRs.
- Touch only the paths your brief grants. If the task seems to need more, stop and report.
- Do not edit `docs/PLAN.md`, `docs/DECISIONS.md`, or `AGENTS.md` (planner-owned).
- Schema changes only under a migration number the planner assigned you (D-002).
- Adapters (`src/app/**`, `src/mcp/**`) call `src/domain/**` only — no SQL, no schema imports (D-011).
- Never derive `org_id` from request arguments; it comes from the authenticated principal (D-007).
- Never log, print, commit, or put in a URL any token, password, or secret (D-009).
- Do not weaken, skip, or delete existing tests to get green. Declare any test you change.
- **Shared checkout:** never run `git stash`, `switch`, `checkout`, `reset`, `clean`, or
  `rebase` in a folder whose branch you did not create. If your brief names a clone path,
  `pwd` must be that path before any git command.
- Temp files outside the repo go in one `mktemp -d` directory you delete before hand-back.

## Hand-back (do all of these unprompted)

1. Merge current `main` into your branch; run the full gate: `npm run lint && npm run
   typecheck && npm test && npm run test:integration` (and `npm run test:e2e` if you touched UI).
2. Push and open the PR yourself: `gh pr create -R StephenForte/agent-message-board -B main`.
3. Wait for CI; fix failures inside your scope.
4. Post the return block (format in your brief) as a PR comment.
5. Tracker check-out (project `cc68fecf-ca89-467a-a30f-f298890b4afc`), if the tools exist.
6. End your session with the return block in one fenced code block.
