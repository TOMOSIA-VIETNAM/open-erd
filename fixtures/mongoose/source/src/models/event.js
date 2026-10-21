const { Schema, model } = require('mongoose');

const ticketTierSchema = new Schema({
  name: { type: String, required: true },
  priceCents: { type: Number, required: true },
  capacity: Number,
  // Co-sponsoring organizer that pays for this tier's perks.
  sponsor: { type: Schema.Types.ObjectId, ref: 'Organizer' },
});

const eventSchema = new Schema(
  {
    title: { type: String, required: true },
    organizer: { type: Schema.Types.ObjectId, ref: 'Organizer', required: true },
    venue: { type: Schema.Types.ObjectId, ref: 'Venue' },
    startsAt: { type: Date, required: true },
    status: { type: String, enum: ['draft', 'on_sale', 'sold_out', 'cancelled'], default: 'draft' },
    tags: [{ type: Schema.Types.ObjectId, ref: 'Tag' }],
    ticketTiers: [ticketTierSchema],
  },
  { timestamps: true },
);

module.exports = model('Event', eventSchema);
