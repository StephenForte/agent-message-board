# Audit log

Owner-only, newest-first pages of `audit_records` inside one `withOrgTx`. Agents and other non-owners receive `capability_denied` before a transaction opens.

`agent.session_seen` rows are omitted unless `includeSessionSeen` is true. The cursor is bound to the organization and that flag; a stale or swapped cursor is `invalid_cursor`.

Each entry names the human, or the agent plus token prefix, and summarizes before/after fields. The summary is truncated. Message bodies are not stored on these rows.
