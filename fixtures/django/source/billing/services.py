from billing.models import Insurer, Invoice, Payment


def submit_claim(invoice: Invoice) -> dict:
    """Send the unpaid part of an invoice to the patient's insurer."""
    if invoice.insurer_id is None:
        raise ValueError("invoice has no insurer")
    insurer = Insurer.objects.get(pk=invoice.insurer_id)
    paid = sum(p.amount for p in invoice.payments.all())
    return {
        "endpoint": insurer.claim_endpoint,
        "invoice": invoice.pk,
        "amount": str(invoice.total - paid),
    }


def record_payment(invoice: Invoice, method: int, amount, user) -> Payment:
    payment = Payment.objects.create(invoice=invoice, method=method, amount=amount, received_by=user)
    if sum(p.amount for p in invoice.payments.all()) >= invoice.total:
        invoice.status = Invoice.Status.PAID
        invoice.save(update_fields=["status"])
    return payment
