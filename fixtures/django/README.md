# django

Clinic app: `accounts`, `clinic`, `billing` apps, one PostgreSQL database, 16 tables, 20 relations, 1 polymorphic association.

- Table names come from Django: `<app>_<model lowercased>` (`accounts_staffprofile`), except `Patient` whose `Meta.db_table` is `patients`.
- `StaffProfile.teams` is a plain `ManyToManyField`: its join table `accounts_staffprofile_teams` exists in no file (`generated_by: Django ManyToManyField`). `unique_together` on `AppointmentProcedure` is a table-level `unique`. `Appointment.procedures` uses `through=` so the join table is the `AppointmentProcedure` model.
- `Patient.primary_doctor` uses `db_column="doctor_ref"`: the column is not `primary_doctor_id`. FKs to `settings.AUTH_USER_MODEL` resolve to `accounts.User` (config/settings.py).
- `OneToOneField` (`StaffProfile.user`, `Invoice.appointment`) is `1-1`. `ForeignKey("self")` on `Team` is a self-reference.
- `db_constraint=False` (`Prescription.medication`, `InvoiceLine.procedure`) is `declared`, not `db_fk`.
- `Invoice.insurer_id` is a bare `IntegerField`; only `billing/services.py#submit_claim` shows it points to `Insurer` (`inferred`).
- `Note.content_object` is a `GenericForeignKey`: targets come from the `GenericRelation` fields on `Patient`, `Appointment` and `Invoice`. `django_content_type` is a framework table and is left out, so `content_type_id` has no relation.
- Enums live only in `TextChoices`/`IntegerChoices`; integer choices are keyed by the stored number.
- Schema gap: a polymorphic `type_column` here holds a content-type id, not a class name; the model cannot say which table it resolves through.
