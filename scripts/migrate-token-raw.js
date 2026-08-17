require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../src/db/connect');
const Order = require('../src/models/Order');
const { PREFIX, encryptSecret } = require('../src/services/secretBox.service');

const main = async () => {
  await connectDB();
  let migrated = 0;

  const cursor = Order.find({ tokenRaw: { $type: 'string' } }).select('+tokenRaw').cursor();
  for await (const order of cursor) {
    if (!order.tokenRaw || order.tokenRaw.startsWith(PREFIX)) continue;
    await Order.updateOne(
      { _id: order._id },
      { $set: { tokenRaw: encryptSecret(order.tokenRaw) } }
    );
    migrated += 1;
  }

  console.log(`Encrypted legacy order tokens: ${migrated}`);
  await mongoose.connection.close();
};

main().catch(async (err) => {
  console.error(`Token migration failed: ${err.message}`);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exitCode = 1;
});
