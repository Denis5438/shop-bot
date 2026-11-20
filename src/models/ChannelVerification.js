const mongoose = require('mongoose');

const channelVerificationSchema = new mongoose.Schema(
  {
    channelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RequiredChannel',
      required: true,
    },
    userId: {
      type: String,
      required: true,
    },
    verifiedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
    versionKey: false,
    collection: 'channel_verifications',
  }
);

channelVerificationSchema.index({ channelId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('ChannelVerification', channelVerificationSchema);
