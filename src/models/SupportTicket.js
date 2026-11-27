const mongoose = require('mongoose');
const crypto = require('crypto');

const generateTicketNumberCode = () => {
  const num = crypto.randomInt(1000, 10000);
  return `SUP-${num}`;
};

const supportTicketSchema = new mongoose.Schema({
  ticketNumber: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  telegramId: { type: Number, required: true },
  topic: {
    type: String,
    enum: ['order', 'payment', 'product', 'general'],
    default: 'general',
  },
  topicLabel: { type: String, default: '' },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  status: {
    type: String,
    enum: ['open', 'in_progress', 'escalated', 'closed'],
    default: 'open',
  },
  priority: {
    type: String,
    enum: ['normal', 'high'],
    default: 'normal',
  },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  assignedTelegramId: { type: Number, default: null },
  takenAt: { type: Date, default: null },
  firstResponseAt: { type: Date, default: null },
  firstResponseBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  lastMessageAt: { type: Date, default: Date.now },
  lastMessageByRole: { type: String, default: 'user' },
  lastReminderAt: { type: Date, default: null },
  reminderCount: { type: Number, default: 0 },
  escalatedAt: { type: Date, default: null },
  escalatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  escalationReason: { type: String, default: null },
  closedAt: { type: Date, default: null },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  closeReason: {
    type: String,
    enum: ['resolved', 'user_closed', 'auto_timeout', null],
    default: null,
  },
  rating: { type: Number, min: 1, max: 5, default: null },
  ratedAt: { type: Date, default: null },
  groupChatId: { type: Number, default: null },
  groupMessageId: { type: Number, default: null },
  staffNotifyMessages: [{
    chatId: { type: Number, required: true },
    messageId: { type: Number, required: true },
    _id: false,
  }],
}, {
  timestamps: true,
});

supportTicketSchema.index({ ticketNumber: 1 }, { unique: true });
supportTicketSchema.index({ status: 1, assignedTo: 1 });
supportTicketSchema.index(
  { status: 1 },
  { partialFilterExpression: { assignedTo: null }, name: 'support_waiting_unassigned_idx' }
);
supportTicketSchema.index({ status: 1, createdAt: -1 });
supportTicketSchema.index({ userId: 1, createdAt: -1 });
supportTicketSchema.index({ assignedTo: 1, status: 1, closedAt: -1 });
supportTicketSchema.index({ status: 1, lastMessageAt: 1 });

supportTicketSchema.pre('validate', function (next) {
  if (!this.ticketNumber) {
    this.ticketNumber = generateTicketNumberCode();
  }
  next();
});

supportTicketSchema.statics.generateUniqueTicketNumber = async function () {
  for (let i = 0; i < 10; i++) {
    const candidate = generateTicketNumberCode();
    const exists = await this.exists({ ticketNumber: candidate });
    if (!exists) return candidate;
  }
  return `SUP-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
