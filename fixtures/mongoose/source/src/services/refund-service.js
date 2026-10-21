const Order = require('../models/order');
const Refund = require('../models/refund');

async function issueRefund(orderId, reason) {
  const order = await Order.findById(orderId);
  if (!order || order.status !== 'paid') throw new Error('order not refundable');
  const refund = await Refund.create({ orderId: order._id, amountCents: order.totalCents, reason });
  order.status = 'refunded';
  await order.save();
  return refund;
}

async function refundsForOrder(orderId) {
  return Refund.find({ orderId });
}

module.exports = { issueRefund, refundsForOrder };
