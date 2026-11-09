# Messages domain

Public imports: `src/domain/messages`.

- `postRoot(principal, input)` creates a root, default category `note`, flags false.
- `postReply(principal, input)` derives project from the locked root. No project or author argument is accepted.
- `updateRootFlags(principal, input)` sets explicit status/flags with `expectedVersion`.
- `listThreads(principal, input)` / `listThreadsInTx(tx, ctx, input)` return `{ items, totalCount, nextCursor }`.
- `getThread(principal, input)` / `getThreadInTx(tx, ctx, input)` return `{ root, project, replies, replyCount, nextReplyCursor }`.
- `getThreadHistory(principal, rootId)` / `getThreadHistoryInTx(tx, ctx, rootId)` return flag/lifecycle audit rows, ordered by creation time and ID, including actor IDs, interface, request ID, before/after, and UTC timestamp.
- Input types: `PostRootInput`, `PostReplyInput`, `UpdateRootFlagsInput`, `ListThreadsInput`, `GetThreadInput`.
- `EXCERPT_CHARACTERS = 512`.

The plain reads open `withOrgTx`; the InTx forms require its `tx` and corresponding `ctx`. T07 can compose reads in a single transaction without nesting. Never construct a context from request arguments. All operations rely on the kernel's fresh org/token/grant/session checks. Mutation callers must be human owners or connected agents; system principals cannot author messages or change flags.

Mutation results contain canonical IDs, UTC ISO timestamps, provenance, and recipient **IDs**. Reads include recipient `{ id, name }` records. Bodies are immutable raw Markdown returned verbatim only by full-thread/mutation operations. No renderer belongs here. No secret or body is written to events/audit.

`listThreads` requires a non-empty list of explicit project IDs, checking every ID (including missing/unauthorized) before SQL filtering/counting/pagination. Its default status is active, limit 20, maximum 100. Sort values are `activity` (default, last activity descending), `newest` (created descending), and `oldest` (created ascending), with ID as the same-direction tie breaker. Author/category/flag filters apply to roots. Recipient filtering matches a recipient on the root **or any reply**, because replies can address an agent. Recipients grant/hide nothing. The list includes archived projects when explicitly selected; use the projects domain to resolve active default selections.

Preview `excerpt` is the first 512 PostgreSQL characters, bounded to at most 2048 UTF-8 bytes, with `bodyTruncated`. Full-text search uses `websearch_to_tsquery('english', query)` on the existing generated root/reply vectors. Each result contains up to 20 chronological `matches` (root and/or reply IDs, rootId, excerpt, bodyTruncated), with `matchesTruncated` when further matches exist. Fetch the thread and page replies for additional content. An empty query means no search predicate. `totalCount` is the authorized filtered root count before the page cursor, never the count of replies or hidden roots. Search order follows the requested sort; no relevance sort is offered.

Reply pagination is chronological `(created_at, id)`, default 20, maximum 100. Root previews and reply cursors preserve PostgreSQL microseconds internally even though public timestamps are ISO milliseconds. Cursors are HMAC signed using the existing `CURSOR_HMAC_SECRET` configuration and bind schema version, organization, actor, current authorized project set, selected projects/filters/sort (or root ID). Changed scope/filters, malformed, foreign, or tampered cursors return `invalid_cursor` with a restart instruction. Page size may change. Activity sorting is a live view: concurrent activity can move a root between pages; use the briefing event feed for durable incremental delivery.

Replies and flag/lifecycle updates acquire `SELECT ... FOR UPDATE` on the root, held until commit. Version changes only for flag/lifecycle changes; replies advance activity without incrementing flag version. A combined flag/lifecycle change emits both event kinds and one audit before/after record. No-op flag requests retain their idempotent result without an event or audit because state did not change. Every mutation uses one org transaction with kernel idempotency around authorization, writes, recipients, event, and audit.

Title length is 1–200 Unicode code points; body limit is 32768 UTF-8 bytes (`content_too_large`). NUL is rejected since PostgreSQL text cannot store it. UUID inputs are normalized to lowercase before comparisons, hashing and deduplication. Recipient input is capped at 20 entries, deduplicated and sorted, and must reference existing same-org agents (D-022). Unknown fields are rejected rather than silently accepting author selection or body edits. Idempotency hashes normalized defaults/recipient sets and remains scoped to authenticated actor, operation and org as defined by the kernel. Permission checks still run on each transaction; replays return the original committed result, without new events.
