const { Schema, model } = require('mongoose');

const checkInSchema = new Schema({
  ticket: { type: Schema.Types.ObjectId, ref: 'Ticket', required: true, unique: true },
  scannedBy: { type: Schema.Types.ObjectId, ref: 'Person', required: true },
  scannedAt: { type: Date, default: Date.now },
});

module.exports = model('CheckIn', checkInSchema);
