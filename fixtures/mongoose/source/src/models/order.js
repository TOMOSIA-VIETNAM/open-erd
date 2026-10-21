const { Schema, model } = require('mongoose');

const orderItemSchema = new Schema({
  event: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
  tierName: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  unitPriceCents: { type: Number, required: true },
});

const orderSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'paid', 'refunded', 'expired'], default: 'pending' },
    totalCents: { type: Number, required: true },
    items: { type: [orderItemSchema], required: true },
  },
  { timestamps: true },
);

module.exports = model('Order', orderSchema);
