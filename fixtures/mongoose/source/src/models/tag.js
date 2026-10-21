const { Schema, model } = require('mongoose');

const tagSchema = new Schema({
  label: { type: String, required: true, unique: true },
});

module.exports = model('Tag', tagSchema);
