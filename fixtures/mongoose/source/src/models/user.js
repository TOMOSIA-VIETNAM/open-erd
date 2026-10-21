const { Schema, model } = require('mongoose');

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true },
    displayName: { type: String, required: true },
    phone: String,
    role: { type: String, enum: ['attendee', 'organizer', 'admin'], default: 'attendee' },
    // Who invited this user; drives the referral bonus.
    referredBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

module.exports = model('User', userSchema);
