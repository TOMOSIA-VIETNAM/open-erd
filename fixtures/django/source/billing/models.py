from django.conf import settings
from django.contrib.contenttypes.fields import GenericRelation
from django.db import models


class Insurer(models.Model):
    name = models.CharField(max_length=120)
    claim_endpoint = models.URLField()


class Invoice(models.Model):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        ISSUED = "issued", "Issued"
        PAID = "paid", "Paid"
        VOID = "void", "Void"

    appointment = models.OneToOneField("clinic.Appointment", on_delete=models.PROTECT, related_name="invoice")
    patient = models.ForeignKey("clinic.Patient", on_delete=models.PROTECT, related_name="invoices")
    # Plain integer: insurers used to live in another system.
    insurer_id = models.IntegerField(null=True, blank=True)
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.DRAFT)
    total = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    issued_at = models.DateTimeField(null=True, blank=True)
    notes = GenericRelation("clinic.Note")


class InvoiceLine(models.Model):
    invoice = models.ForeignKey(Invoice, on_delete=models.CASCADE, related_name="lines")
    # Kept after a procedure is retired from the price list.
    procedure = models.ForeignKey(
        "clinic.Procedure", null=True, on_delete=models.DO_NOTHING, db_constraint=False
    )
    description = models.CharField(max_length=200)
    amount = models.DecimalField(max_digits=10, decimal_places=2)


class Payment(models.Model):
    class Method(models.IntegerChoices):
        CASH = 1, "Cash"
        CARD = 2, "Card"
        INSURANCE = 3, "Insurance"

    invoice = models.ForeignKey(Invoice, on_delete=models.PROTECT, related_name="payments")
    method = models.SmallIntegerField(choices=Method.choices)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    received_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    received_at = models.DateTimeField(auto_now_add=True)
