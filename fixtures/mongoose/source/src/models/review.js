const { Schema, model } = require('mongoose');

const reviewSchema = new Schema(
  {
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    subjectModel: { type: String, required: true, enum: ['Event', 'Venue', 'Organizer'] },
    subject: { type: Schema.Types.ObjectId, required: true, refPath: 'subjectModel' },
    rating: { type: Number, min: 1, max: 5, required: true },
    body: String,
  },
  { timestamps: true, collection: 'feedback_entries' },
);

module.exports = model('Review', reviewSchema);
