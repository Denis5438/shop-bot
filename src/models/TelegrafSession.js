const mongoose = require('mongoose');
const logger = require('../config/logger');

const telegrafSessionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    session: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: false,
    versionKey: false,
    collection: 'telegraf_sessions',
  }
);

// TTL index: 7 days (604800 seconds)
telegrafSessionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

const TelegrafSession = mongoose.model('TelegrafSession', telegrafSessionSchema);

function createMongoSessionStore() {
  return {
    async get(key) {
      try {
        const doc = await TelegrafSession.findOne({ key }).lean();
        return doc ? doc.session : undefined;
      } catch (err) {
        logger.error(`[MongoSession] Error fetching session for key ${key}: ${err.message}`);
        return undefined;
      }
    },
    async set(key, session) {
      try {
        await TelegrafSession.updateOne(
          { key },
          { $set: { session, updatedAt: new Date() } },
          { upsert: true }
        );
      } catch (err) {
        logger.error(`[MongoSession] Error saving session for key ${key}: ${err.message}`);
      }
    },
    async delete(key) {
      try {
        await TelegrafSession.deleteOne({ key });
      } catch (err) {
        logger.error(`[MongoSession] Error deleting session for key ${key}: ${err.message}`);
      }
    },
  };
}

module.exports = { TelegrafSession, createMongoSessionStore };
