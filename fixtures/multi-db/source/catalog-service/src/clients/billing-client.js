'use strict';
// HTTP client for billing-service. stock_reservations.invoice_id holds a
// billing invoice id (uuid); catalog has no access to the billing database.
const BILLING_URL = process.env.BILLING_SERVICE_URL || 'http://billing-service:3000';

async function getInvoice(tenantSlug, invoiceId) {
  const res = await fetch(`${BILLING_URL}/internal/tenants/${tenantSlug}/invoices/${invoiceId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`billing-service responded ${res.status}`);
  return res.json();
}

module.exports = { getInvoice };
