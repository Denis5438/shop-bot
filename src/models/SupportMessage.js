const mongoose = require('mongoose');

const supportMessageSchema = new mongoose.Schema({
  ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupportTicket', required: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  senderTelegramId: { type: Number, default: null },
  senderRole: {
    type: String,
    enum: ['user', 'support', 'moderator', 'admin', 'superadmin', 'system'],
    required: true,
  },
  text: { type: String, default: '' },
  mediaType: {
    type: String,
    enum: ['photo', 'document', 'video', null],
    default: null,
  },
  mediaFileId: { type: String, default: null },
  mediaDataUrl: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

supportMessageSchema.index({ ticketId: 1, createdAt: 1 });

module.exports = mongoose.model('SupportMessage', supportMessageSchema);
