const { Schema, model } = require('mongoose');

const addressSchema = new Schema(
  {
    line1: String,
    city: String,
    country: String,
    postalCode: String,
  },
  { _id: false },
);

const venueSchema = new Schema({
  name: { type: String, required: true },
  capacity: Number,
  // Single nested subdocument, stored inside the venue document.
  address: addressSchema,
});

module.exports = model('Venue', venueSchema);
