# Organization home

Owner read model for `/`. One `withOrgTx` composes `listProjectsInTx` (active projects only), one grouped root-count query, `listAgentsInTx`, and `getAnnouncementsInTx`. Query count does not grow with the number of projects.

Active and urgent counts are roots with `status = 'active'`. Archived threads and replies are excluded. Archived projects are omitted. `lastActivityAt` is the latest active root, or null.

`getOwnerProfile` returns the signed-in owner's display name. Agents receive `capability_denied` before a transaction opens.
