'use strict';
const { getInvoice } = require('../clients/billing-client');

// Commit held stock once billing confirms the invoice is paid.
async function commitReservation(models, reservationId, tenantSlug) {
  const reservation = await models.StockReservation.findByPk(reservationId);
  if (!reservation || reservation.status !== 'held') return null;
  const invoice = await getInvoice(tenantSlug, reservation.invoiceId);
  if (!invoice || invoice.status !== 'paid') return null;
  reservation.status = 'committed';
  return reservation.save();
}

module.exports = { commitReservation };
