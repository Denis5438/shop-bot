require('dotenv').config();

const mongoose = require('mongoose');
const { Telegraf } = require('telegraf');
const connectDB = require('../src/db/connect');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');
const User = require('../src/models/User');
const { formatDigitalItem, escapeHtml } = require('../src/bot/utils/ui');
const config = require('../src/config');

const ORDER_ID = '6aa7a90de39afa10f6b58d45';
const TARGET_TELEGRAM_ID = 5816207940;
const REAL_DELIVERY_DATA = 'hbbr897896562+nnofm826@gmail.com|dreYWi2CR3A2|Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC';

const run = async () => {
  console.log(`Connecting to database...`);
  await connectDB();

  console.log(`Finding order ${ORDER_ID}...`);
  const order = await Order.findById(ORDER_ID).populate('productId').populate('userId');

  if (!order) {
    console.error(`Order ${ORDER_ID} not found in database!`);
  } else {
    console.log(`Found order: ${order._id}, current status: ${order.status}, deliveryData: ${order.deliveryData}`);
    
    order.deliveryData = REAL_DELIVERY_DATA;
    order.status = 'completed';
    if (!order.supplierOrderId) {
      order.supplierOrderId = 'ORD-00000450';
    }
    order.confirmedAt = order.confirmedAt || new Date();
    order.activationResult = 'Ручное исправление данных поставщика Jaha Digital ⚡';
    await order.save();
    console.log(`Order ${ORDER_ID} successfully updated with real deliveryData!`);
  }

  const botToken = config.BOT_TOKEN || process.env.BOT_TOKEN;
  if (!botToken) {
    console.warn(`BOT_TOKEN not found! Cannot send Telegram notification.`);
    await mongoose.connection.close();
    return;
  }

  const bot = new Telegraf(botToken);
  const userLang = order?.userId?.language || 'ru';
  const productName = escapeHtml(order?.productId?.name || 'ChatGPT Plus / Подписка');
  const formattedKeys = formatDigitalItem(REAL_DELIVERY_DATA, userLang);

  const message = userLang === 'en'
    ? `Hello! We sincerely apologize for the technical delay in the automatic delivery of your order #<code>${ORDER_ID}</code>.\n\n` +
      `📦 <b>Product:</b> ${productName}\n\n` +
      `🔑 <b>Your access data:</b>\n` +
      `${formattedKeys}\n\n` +
      `ℹ️ <i>Tap on the code field to copy it in 1 click.</i>\n\n` +
      `🛡 <i>Warranty is valid in full. Enjoy using the service!</i>`
    : `Здравствуйте! Приносим искренние извинения за техническую задержку при автоматической выдаче вашего заказа #<code>${ORDER_ID}</code>.\n\n` +
      `📦 <b>Товар:</b> ${productName}\n\n` +
      `🔑 <b>Ваши данные для доступа:</b>\n` +
      `${formattedKeys}\n\n` +
      `ℹ️ <i>Нажмите на значение в поле, чтобы скопировать его в 1 клик.</i>\n\n` +
      `🛡 <i>Гарантия на заказ действует в полном объеме. Приятного пользования!</i>`;

  console.log(`Sending notification to Telegram ID ${TARGET_TELEGRAM_ID}...`);
  try {
    await bot.telegram.sendMessage(TARGET_TELEGRAM_ID, message, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: userLang === 'en' ? '📋 My orders' : '📋 Мои покупки', callback_data: `profile:order:detail:${ORDER_ID}` }],
        ],
      },
    });
    console.log(`Notification successfully sent to user ${TARGET_TELEGRAM_ID}!`);
    if (order) {
      order.notes = (order.notes ? order.notes + ' ' : '') + '[repair_notification_sent]';
      await order.save();
    }
  } catch (tgErr) {
    console.error(`Failed to send Telegram message: ${tgErr.message}`);
  }

  await mongoose.connection.close();
  console.log(`Done.`);
};

run().catch(async (err) => {
  console.error(`Script error:`, err);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});
