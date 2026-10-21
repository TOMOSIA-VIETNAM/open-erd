const mongoose = require('mongoose');

// Connection string comes from the environment; nothing is hard-coded here.
async function connect() {
  await mongoose.connect(process.env.MONGO_URL, { dbName: 'ticketing' });
}

module.exports = { connect };
