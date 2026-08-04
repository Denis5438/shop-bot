const mongoose = require('mongoose');

const requiredChannelSchema = new mongoose.Schema({
  title: { type: String, required: true },
  chatId: { type: String, required: true },
  inviteLink: { type: String, required: true },
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('RequiredChannel', requiredChannelSchema);
