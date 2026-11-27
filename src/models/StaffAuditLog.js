const mongoose = require('mongoose');

const staffAuditLogSchema = new mongoose.Schema({
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  targetTelegramId: { type: Number, required: true },
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  actorTelegramId: { type: Number, required: true },
  oldRole: {
    type: String,
    enum: ['user', 'support', 'moderator', 'admin', 'superadmin'],
    required: true,
  },
  newRole: {
    type: String,
    enum: ['user', 'support', 'moderator', 'admin', 'superadmin'],
    required: true,
  },
  reason: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

staffAuditLogSchema.index({ createdAt: -1 });
staffAuditLogSchema.index({ targetUserId: 1, createdAt: -1 });

module.exports = mongoose.model('StaffAuditLog', staffAuditLogSchema);
