const { Schema, model } = require('mongoose');

const refundSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, required: true },
    amountCents: { type: Number, required: true },
    reason: { type: String, enum: ['event_cancelled', 'customer_request', 'duplicate_charge'] },
  },
  { timestamps: true },
);

module.exports = model('Refund', refundSchema);
