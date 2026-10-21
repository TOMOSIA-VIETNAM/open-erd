const { Schema, model } = require('mongoose');

const organizerSchema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    payoutStatus: { type: String, enum: ['unverified', 'verified', 'suspended'], default: 'unverified' },
  },
  { timestamps: true },
);

module.exports = model('Organizer', organizerSchema);
