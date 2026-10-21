const { Schema, model } = require('mongoose');

const ticketSchema = new Schema({
  order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
  event: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
  // Set when the buyer transfers the ticket to someone else.
  holder: { type: Schema.Types.ObjectId, ref: 'User' },
  code: { type: String, required: true, unique: true },
  status: { type: String, enum: ['valid', 'used', 'void'], default: 'valid' },
});

module.exports = model('Ticket', ticketSchema);
