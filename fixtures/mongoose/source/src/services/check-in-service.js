const Ticket = require('../models/ticket');
const CheckIn = require('../models/check-in');

async function scanTicket(code, staffId) {
  const ticket = await Ticket.findOne({ code, status: 'valid' }).populate('event');
  if (!ticket) throw new Error('invalid ticket');
  await CheckIn.create({ ticket: ticket._id, scannedBy: staffId });
  ticket.status = 'used';
  await ticket.save();
  return ticket;
}

module.exports = { scanTicket };
