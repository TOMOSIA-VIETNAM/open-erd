# prisma

Online course platform, one `schema.prisma` (Postgres, default relationMode, so every `@relation` is `db_fk`). 14 tables, 19 relations, no polymorphic.

Traps:
- `@@map` / `@map` rename tables and columns (`Review` is `course_reviews`). `Lesson.createdAt` has no `@map`, so its column stays camelCase.
- Two relations between `courses` and `users` told apart only by the relation names `CourseAuthor` and `CourseReviewer`. `categories` refers to itself through `CategoryTree`.
- `enrollments` has a composite `@@id`. `lesson_progress` references it with a two-column foreign key.
- Implicit many-to-many `Course.tags` / `Tag.courses` makes a join table that is not in the schema file: `_CourseToTag(A, B)`, `generated_by: Prisma implicit many-to-many`. A is the Course side because model names are sorted alphabetically.
- `@@unique([...])` over two columns (lessons, lesson_progress, course_reviews) is a table-level `unique`.
- One-to-one through the `@unique` column `user_profiles.user_id`. `orders.coupon_code` references `coupons.code`, a unique column that is not the primary key.
- `CourseStatus` values use `@map`, so the stored values (`in_review`) differ from the TypeScript names (`IN_REVIEW`).
- `audit_events.actor_id` has no `@relation`. Only `src/services/audit-service.ts#listAuditWithActor` shows it holds a `users.id`, so the relation is `inferred`.
