const { Telegraf } = require('telegraf');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.command('test_colors', (ctx) => {
  ctx.reply('Test', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Green', callback_data: 'g', style: 'success' },
          { text: 'Red', callback_data: 'r', style: 'danger' },
          { text: 'Primary', callback_data: 'p', style: 'primary' }
        ]
      ]
    }
  });
});

bot.launch().then(() => {
  console.log('Bot launched');
  setTimeout(() => process.exit(0), 10000);
});
