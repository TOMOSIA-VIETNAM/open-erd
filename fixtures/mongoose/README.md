# mongoose — ticketing API (MongoDB, 11 collections)

- Collection names differ from model names: `Person` -> `people` (Mongoose pluralizer), `CheckIn` -> `checkins`, `Review` -> `feedback_entries` (explicit `collection:` option).
- Every `ref:` is `kind: declared`: MongoDB has no foreign key constraints.
- `events.tags` is an array of `Tag` refs with no join collection: expected has one `n-n` relation from `events.tags` to `tags._id`.
- `feedback_entries.subject` uses `refPath: 'subjectModel'`: a polymorphic association, not a relation.
- `refunds.orderId` has no `ref`; only `src/services/refund-service.js#issueRefund` shows it holds an order id (`inferred`).
- Self-reference `users.referredBy`; 1-1 via `unique` on `checkins.ticket`; enums declared on schema paths.
- Embedded subdocuments (`venues.address`, `events.ticketTiers`, `orders.items`) are `embedded` entities, not columns. Their refs are relations from the embedded path: `events.ticketTiers.sponsor -> organizers` and `orders.items.event -> events`.
