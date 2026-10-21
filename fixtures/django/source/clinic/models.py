from django.conf import settings
from django.contrib.contenttypes.fields import GenericForeignKey, GenericRelation
from django.contrib.contenttypes.models import ContentType
from django.db import models


class Patient(models.Model):
    class Sex(models.TextChoices):
        FEMALE = "F", "Female"
        MALE = "M", "Male"
        UNKNOWN = "U", "Not stated"

    full_name = models.CharField(max_length=120)
    birth_date = models.DateField()
    sex = models.CharField(max_length=1, choices=Sex.choices, default=Sex.UNKNOWN)
    primary_doctor = models.ForeignKey(
        "accounts.StaffProfile",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        db_column="doctor_ref",
        related_name="patients",
    )
    notes = GenericRelation("clinic.Note")

    class Meta:
        db_table = "patients"


class Room(models.Model):
    class Kind(models.IntegerChoices):
        CONSULTATION = 1, "Consultation"
        SURGERY = 2, "Surgery"
        IMAGING = 3, "Imaging"

    code = models.CharField(max_length=10, unique=True)
    kind = models.SmallIntegerField(choices=Kind.choices)


class Procedure(models.Model):
    code = models.CharField(max_length=16, unique=True)
    name = models.CharField(max_length=200)
    price = models.DecimalField(max_digits=10, decimal_places=2)


class Appointment(models.Model):
    class Status(models.TextChoices):
        BOOKED = "booked", "Booked"
        CHECKED_IN = "checked_in", "Checked in"
        DONE = "done", "Done"
        NO_SHOW = "no_show", "No show"

    patient = models.ForeignKey(Patient, on_delete=models.PROTECT, related_name="appointments")
    doctor = models.ForeignKey("accounts.StaffProfile", on_delete=models.PROTECT, related_name="appointments")
    room = models.ForeignKey(Room, null=True, on_delete=models.SET_NULL)
    scheduled_at = models.DateTimeField()
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.BOOKED)
    procedures = models.ManyToManyField(Procedure, through="AppointmentProcedure")
    notes = GenericRelation("clinic.Note")


class AppointmentProcedure(models.Model):
    appointment = models.ForeignKey(Appointment, on_delete=models.CASCADE)
    procedure = models.ForeignKey(Procedure, on_delete=models.PROTECT)
    quantity = models.PositiveIntegerField(default=1)

    class Meta:
        unique_together = [("appointment", "procedure")]


class Note(models.Model):
    """Free-text note attached to a patient, an appointment or an invoice."""

    content_type = models.ForeignKey(ContentType, on_delete=models.CASCADE)
    object_id = models.PositiveBigIntegerField()
    content_object = GenericForeignKey("content_type", "object_id")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)


class Medication(models.Model):
    # Rows are synced nightly from the pharmacy catalogue, ids are kept stable.
    name = models.CharField(max_length=200)
    atc_code = models.CharField(max_length=8)


class Prescription(models.Model):
    appointment = models.ForeignKey(Appointment, on_delete=models.CASCADE, related_name="prescriptions")
    # No DB constraint: the nightly catalogue sync deletes and re-inserts rows.
    medication = models.ForeignKey(Medication, on_delete=models.DO_NOTHING, db_constraint=False)
    dosage = models.CharField(max_length=120)
    days = models.PositiveSmallIntegerField()
