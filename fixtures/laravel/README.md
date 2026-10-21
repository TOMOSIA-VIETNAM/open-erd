# laravel

Small CRM (15 tables, MySQL) built with Laravel migrations and Eloquent.

- Mixed constraints: `constrained()` / `foreign()` create FKs (`db_fk`), while `teams.owner_id`, `companies.owner_user_id`, `deals.owner_id`, `notes.author_id`, `email_campaigns.created_by` are bare `unsignedBigInteger` linked only by `belongsTo` (`declared`).
- Custom foreign keys: `belongsTo(User::class, 'owner_user_id')`, `stage()` on `pipeline_stage_id`, `constrained('email_campaigns')` for `campaign_id`.
- Polymorphic: `morphs('subject')` + `morphTo`/`morphMany` (activities), `nullableMorphs('noteable')` (notes), `morphToMany`/`morphedByMany` through `taggables`; `*_type` stores morph-map aliases from `AppServiceProvider`.
- Enums in code only: PHP backed enums cast in `$casts` (string `UserRole`, `ContactStatus`, `DealStatus`; int `ActivityType`); `team_members.role` is a DB `enum(...)`.
- `belongsToMany(..., 'team_members')`: pivot name differs from the default `team_user`; composite primary key.
- `hasOne` profile with unique `user_id` (`1-1`); self-reference `users.manager_id`.
- Inferred only: `campaign_recipients.contact_id` has no association; it is used only in `SendCampaignJob::handle`.
- Schema gap: the model cannot mark a relation as a pivot of a named `belongsToMany`, nor `taggables` as a polymorphic join table; both are expressed as plain relations plus a `polymorphic` entry.
