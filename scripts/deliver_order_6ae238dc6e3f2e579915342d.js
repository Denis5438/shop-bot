const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();

const mongoose = require('mongoose');
const { Telegraf } = require('telegraf');
require('../src/models/User');
require('../src/models/Product');
const Order = require('../src/models/Order');
const { formatDigitalItem, escapeHtml, get2FAButtonLabel, has2FASecret } = require('../src/bot/utils/ui');
const { grantReferralBonusForFirstCompletedOrder } = require('../src/services/referral.service');
const config = require('../src/config');

const ORDER_ID = '6ae238dc6e3f2e579915342d';
const TARGET_TELEGRAM_ID = 8240687535;
const REAL_DELIVERY_DATA = 'burwellferrari316@gmail.com|Phamhoangdien14@|MXF5UCUDQBBE3R7SNBM6SIXXMZRAQP6E';
const SUPPLIER_ORDER_ID = 'ORD-00001127';

async function run() {
  console.log(`Connecting to database...`);
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log(`Connected to database.`);

  console.log(`Finding order ${ORDER_ID}...`);
  const order = await Order.findById(ORDER_ID).populate('productId').populate('userId');

  if (!order) {
    console.error(`Order ${ORDER_ID} not found in database!`);
    await mongoose.connection.close();
    process.exit(1);
  }

  console.log(`Found order: ${order._id}, current status: ${order.status}, deliveryData: ${order.deliveryData}`);

  order.deliveryData = REAL_DELIVERY_DATA;
  order.status = 'completed';
  if (!order.supplierOrderId) {
    order.supplierOrderId = SUPPLIER_ORDER_ID;
  }
  order.confirmedAt = order.confirmedAt || new Date();
  order.activationResult = 'Выдача данных поставщика Jaha Digital ⚡';
  order.nextRetryAt = null;
  if (!order.notes || !order.notes.includes('[delivered_to_buyer]')) {
    order.notes = (order.notes ? order.notes + ' ' : '') + '[delivered_to_buyer]';
  }
  await order.save();
  console.log(`Order ${ORDER_ID} successfully saved with status 'completed' and real deliveryData!`);

  if (order.userId?._id) {
    await grantReferralBonusForFirstCompletedOrder(order.userId._id).catch(() => {});
  }

  const botToken = config.BOT_TOKEN || process.env.BOT_TOKEN;
  if (!botToken) {
    console.warn(`BOT_TOKEN not found! Cannot send Telegram notification.`);
    await mongoose.connection.close();
    return;
  }

  const bot = new Telegraf(botToken);
  const userLang = order?.userId?.language || 'ru';
  const productName = escapeHtml(order?.productId?.name || 'ChatGPT Plus 1 Month [W12H]');
  const formattedKeys = formatDigitalItem(REAL_DELIVERY_DATA, userLang);

  const message = userLang === 'en'
    ? `✅ <b>Your order #${ORDER_ID} has been completed! ⚡</b>\n\n` +
      `📦 <b>Product:</b> ${productName}\n\n` +
      `🔑 <b>Your access data:</b>\n` +
      `${formattedKeys}\n\n` +
      `ℹ️ <i>Tap on the credentials field to copy it in 1 click.</i>\n\n` +
      `🛡 <i>Warranty is valid in full. Enjoy using the service!</i>`
    : `✅ <b>Товар по вашему заказу #${ORDER_ID} выдан! ⚡</b>\n\n` +
      `📦 <b>Товар:</b> ${productName}\n\n` +
      `🔑 <b>Ваши данные для доступа:</b>\n` +
      `${formattedKeys}\n\n` +
      `ℹ️ <i>Нажмите на значение в поле, чтобы скопировать его в 1 клик.</i>\n\n` +
      `🛡 <i>Гарантия на заказ действует в полном объеме. Приятного пользования!</i>`;

  const inlineKeyboard = [];
  if (has2FASecret(REAL_DELIVERY_DATA)) {
    inlineKeyboard.push([{ text: get2FAButtonLabel(userLang), callback_data: `profile:order:2fa:${ORDER_ID}` }]);
  }
  inlineKeyboard.push([{ text: userLang === 'en' ? '📋 My orders' : '📋 Мои покупки', callback_data: `profile:order:detail:${ORDER_ID}` }]);

  console.log(`Sending notification to Telegram ID ${TARGET_TELEGRAM_ID}...`);
  try {
    const sentMsg = await bot.telegram.sendMessage(TARGET_TELEGRAM_ID, message, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: inlineKeyboard,
      },
    });
    console.log(`Notification successfully sent to user ${TARGET_TELEGRAM_ID}! Message ID: ${sentMsg.message_id}`);
    order.notes = (order.notes ? order.notes + ' ' : '') + '[notification_sent_ok]';
    await order.save();
  } catch (tgErr) {
    console.error(`Failed to send Telegram message: ${tgErr.message}`);
  }

  await mongoose.connection.close();
  console.log('Done.');
}

run().catch(async (err) => {
  console.error('Fatal script error:', err);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});
