const { Schema, model } = require('mongoose');

// Door staff who scan tickets. Mongoose stores model "Person" in the "people" collection.
const personSchema = new Schema({
  fullName: { type: String, required: true },
  organizer: { type: Schema.Types.ObjectId, ref: 'Organizer', required: true },
  badgeCode: { type: String, required: true, unique: true },
});

module.exports = model('Person', personSchema);
