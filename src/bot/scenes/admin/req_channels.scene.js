const { Markup } = require('telegraf');
const Settings = require('../../../models/Settings');
const RequiredChannel = require('../../../models/RequiredChannel');
const { getSettings: getCachedSettings, invalidateCache } = require('../../../services/settingsCache.service');
const { escapeHtml } = require('../../utils/ui');

const getLiveSettings = async () => {
  let settings = await Settings.findOne({ name: 'global' });
  if (!settings) {
    settings = await Settings.create({ name: 'global' });
  }
  return settings;
};

const showReqChannelsMain = async (ctx) => {
  const settings = await getCachedSettings();
  const channels = await RequiredChannel.find().sort({ sortOrder: 1, createdAt: 1 });

  const isEnabled = !!settings?.requiredChannelsEnabled;
  const statusStr = isEnabled ? '🟢 Включена (Бот требует подписку)' : '🔴 Выключена (Вход свободный)';
  const toggleBtnStr = isEnabled ? '🔴 Выключить ОП' : '🟢 Включить ОП';

  let text =
    `📢 <b>Управление Обязательной Подпиской (ОП)</b>\n\n` +
    `Статус системы: <b>${statusStr}</b>\n\n` +
    `<b>Подключённые каналы (${channels.length} шт.):</b>\n`;

  if (!channels.length) {
    text += `<i>Каналов пока нет. Добавьте хотя бы один канал!</i>\n`;
  } else {
    channels.forEach((ch, idx) => {
      text += `<b>${idx + 1}. ${escapeHtml(ch.title)}</b>\n`;
      text += `   • ID/Username: <code>${escapeHtml(ch.chatId)}</code>\n`;
      text += `   • Ссылка: ${escapeHtml(ch.inviteLink)}\n\n`;
    });
  }

  text += `\n<i>💡 Не забудьте добавить бота АДМИНИСТРАТОРОМ в ваши каналы, чтобы он мог проверять подписки юзеров!</i>`;

  const buttons = [];

  // Кнопка тумблера
  buttons.push([Markup.button.callback(toggleBtnStr, 'admin:req_channels:toggle')]);

  // Список кнопок удаления по каждому каналу
  channels.forEach((ch, idx) => {
    buttons.push([
      Markup.button.callback(`🗑 Удалить ${idx + 1}. ${ch.title.substring(0, 18)}`, `admin:req_channels:delete:${ch._id}`),
    ]);
  });

  buttons.push([Markup.button.callback('➕ Добавить новый канал', 'admin:req_channels:add')]);
  buttons.push([Markup.button.callback('⬅️ В панель', 'admin:main')]);

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...Markup.inlineKeyboard(buttons) });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...Markup.inlineKeyboard(buttons) });
  }
};

const toggleReqChannels = async (ctx) => {
  const settings = await getLiveSettings();
  settings.requiredChannelsEnabled = !settings.requiredChannelsEnabled;
  await settings.save();
  await invalidateCache();

  await ctx.answerCbQuery(
    settings.requiredChannelsEnabled ? '🟢 Обязательная подписка ВКЛЮЧЕНА!' : '🔴 Обязательная подписка ВЫКЛЮЧЕНА!'
  );
  await showReqChannelsMain(ctx);
};

const deleteReqChannel = async (ctx, channelId) => {
  await RequiredChannel.findByIdAndDelete(channelId);
  await ctx.answerCbQuery('✅ Канал удалён!');
  await showReqChannelsMain(ctx);
};

const startAddChannel = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.step = 'add_req_channel_title';
  ctx.session.reqChannelData = {};

  const text =
    `➕ <b>Добавление нового канала (Шаг 1 из 3)</b>\n\n` +
    `Введите <b>название канала</b> для отображения в списке кнопки.\n` +
    `<i>Пример: 📢 Наш Главный Канал</i>`;

  const buttons = [[Markup.button.callback('❌ Отмена', 'admin:req_channels')]];

  await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

const handleReqChannelInput = async (ctx) => {
  if (!ctx.session?.step || !ctx.message?.text) return false;

  const step = ctx.session.step;
  const input = ctx.message.text.trim();

  if (step === 'add_req_channel_title') {
    ctx.session.reqChannelData.title = input;
    ctx.session.step = 'add_req_channel_chatid';

    await ctx.reply(
      `➕ <b>Добавление канала (Шаг 2 из 3)</b>\n\n` +
      `Название: <b>${escapeHtml(input)}</b>\n\n` +
      `Теперь введите <b>Username или ID канала</b> для проверки подписки через API.\n` +
      `<i>Пример: @my_shop_channel или -100123456789</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:req_channels')]]),
      }
    );
    return true;
  }

  if (step === 'add_req_channel_chatid') {
    let chatId = input;
    if (!chatId.startsWith('@') && !chatId.startsWith('-')) {
      chatId = '@' + chatId;
    }
    ctx.session.reqChannelData.chatId = chatId;
    ctx.session.step = 'add_req_channel_link';

    await ctx.reply(
      `➕ <b>Добавление канала (Шаг 3 из 3)</b>\n\n` +
      `Название: <b>${escapeHtml(ctx.session.reqChannelData.title)}</b>\n` +
      `ID/Username: <code>${escapeHtml(chatId)}</code>\n\n` +
      `Теперь введите <b>ссылку на канал</b> для кнопки пересылки.\n` +
      `<i>Пример: https://t.me/my_shop_channel</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:req_channels')]]),
      }
    );
    return true;
  }

  if (step === 'add_req_channel_link') {
    let inviteLink = input;
    if (!inviteLink.startsWith('http://') && !inviteLink.startsWith('https://')) {
      inviteLink = 'https://' + inviteLink;
    }

    const { title, chatId } = ctx.session.reqChannelData;

    await RequiredChannel.create({
      title,
      chatId,
      inviteLink,
    });

    delete ctx.session.step;
    delete ctx.session.reqChannelData;

    await ctx.reply(`✅ <b>Канал «${escapeHtml(title)}» успешно добавлен!</b>`, { parse_mode: 'HTML' });
    await showReqChannelsMain(ctx);
    return true;
  }

  return false;
};

module.exports = {
  showReqChannelsMain,
  toggleReqChannels,
  deleteReqChannel,
  startAddChannel,
  handleReqChannelInput,
};
