const mongoose = require('mongoose');

const authSessionSchema = new mongoose.Schema({
  sessionToken: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  codeHash: {
    type: String,
    default: null,
  },
  telegramId: {
    type: Number,
    default: null,
    index: true,
  },
  status: {
    type: String,
    enum: ['pending', 'code_issued', 'authenticated', 'verified', 'expired', 'locked'],
    default: 'pending',
    index: true,
  },
  attempts: {
    type: Number,
    default: 0,
  },
  ip: {
    type: String,
    default: null,
  },
  userAgent: {
    type: String,
    default: null,
  },
  codeExpiresAt: {
    type: Date,
    default: null,
  },
  verifiedAt: {
    type: Date,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 600, // MongoDB TTL index: removes document after 10 minutes (600 seconds)
  },
});

module.exports = mongoose.model('AuthSession', authSessionSchema);
