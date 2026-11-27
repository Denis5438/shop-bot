/**
 * Маршруты системы поддержки:
 * - Покупатель (sup:*) -> buyer_support.scene.js
 * - Сотрудники и групповой чат (sp:*, /support, /sapport, /sup, /set_support_chat) -> support_panel.scene.js
 */

const { Markup } = require('telegraf');
const buyerSupportScene = require('../scenes/buyer_support.scene');
const supportPanelScene = require('../scenes/support_panel.scene');
const { supportMiddleware, adminMiddleware, isSupportOrAbove } = require('../middlewares/auth');
const { getSettings, invalidateCache } = require('../../services/settingsCache.service');
const Settings = require('../../models/Settings');
const { escapeHtml } = require('../utils/ui');
const logger = require('../../config/logger');

/**
 * Защита групповых callback'ов (sp:*):
 * вне ЛС действия разрешены только в привязанном settings.supportChatId.
 */
const spGroupSecurityMiddleware = async (ctx, next) => {
  if (ctx.chat?.type && ctx.chat.type !== 'private') {
    const settings = await getSettings();
    if (!settings?.supportChatId || Number(ctx.chat.id) !== Number(settings.supportChatId) || !isSupportOrAbove(ctx.user)) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('⛔ Нет прав', { show_alert: true }).catch(() => {});
      }
      return;
    }
  }
  return next();
};

module.exports = (bot) => {
  // ─── КОМАНДЫ ПАНЕЛИ САППОРТА (/support, /sapport, /sup) ────────────────────
  bot.command(['support', 'sapport', 'sup'], supportMiddleware, async (ctx) => {
    try {
      if (ctx.chat?.type && ctx.chat.type !== 'private') {
        const botUsername = ctx.botInfo?.username;
        const buttons = botUsername
          ? [[Markup.button.url('🎧 Открыть панель в ЛС бота', `https://t.me/${botUsername}?start=support`)]]
          : [];
        return ctx.reply(
          '🎧 <b>Панель саппорта</b> открывается в личных сообщениях с ботом.',
          {
            parse_mode: 'HTML',
            ...(buttons.length ? Markup.inlineKeyboard(buttons) : {}),
          }
        );
      }

      if (ctx.session) {
        ctx.session.supportAction = null;
        ctx.session.activeTicketId = null;
      }
      await supportPanelScene.showSupportPanel(ctx, 'waiting', 1);
    } catch (err) {
      logger.error(`[SupportRoutes] /support command error: ${err.message}`);
    }
  });

  // ─── ПРИВЯЗКА ГРУППОВОГО ЧАТА САППОРТОВ (/set_support_chat) ────────────────
  bot.command('set_support_chat', adminMiddleware, async (ctx) => {
    try {
      if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
        const chatTitle = ctx.chat.title || 'Чат саппортов';
        const updated = await Settings.findOneAndUpdate(
          { name: 'global' },
          {
            $set: {
              supportChatId: Number(ctx.chat.id),
              supportChatTitle: chatTitle,
            },
          },
          { upsert: true, new: true }
        );
        invalidateCache(updated);

        return ctx.reply(
          `✅ <b>Чат саппортов подключён!</b>\n\n` +
          `💬 Группа: <b>${escapeHtml(chatTitle)}</b>\n` +
          `🆔 Chat ID: <code>${ctx.chat.id}</code>\n\n` +
          `Новые тикеты покупателей теперь будут дублироваться в этот чат. ` +
          `Отключить чат и вернуться в режим ЛС можно в <code>/admin</code> → «🎧 Настройки саппортов».`,
          { parse_mode: 'HTML' }
        );
      }

      return ctx.reply(
        `ℹ️ <b>Подключение группового чата саппортов</b>\n\n` +
        `Чтобы подключить общий чат:\n` +
        `1. Добавьте этого бота в вашу группу или супергруппу саппортов.\n` +
        `2. Выдайте боту права на отправку и редактирование сообщений.\n` +
        `3. Напишите прямо в той группе команду:\n<code>/set_support_chat</code>`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      logger.error(`[SupportRoutes] /set_support_chat error: ${err.message}`);
      await ctx.reply('❌ Ошибка при сохранении чата саппортов.').catch(() => {});
    }
  });

  // ─── ПОКУПАТЕЛЬ: ТИКЕТЫ ПОДДЕРЖКИ (sup:*) ─────────────────────────────────
  bot.action('sup:new', async (ctx) => {
    try {
      await buyerSupportScene.startNewTicket(ctx);
    } catch (err) {
      logger.error(`[SupportRoutes] sup:new error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка открытия формы').catch(() => {});
    }
  });

  bot.action(/^sup:top:(order|payment|product|general)$/, async (ctx) => {
    try {
      await buyerSupportScene.handleTopicSelection(ctx, ctx.match[1]);
    } catch (err) {
      logger.error(`[SupportRoutes] sup:top error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка выбора темы').catch(() => {});
    }
  });

  bot.action(/^sup:ord:([a-f0-9]{24}|none)$/, async (ctx) => {
    try {
      await buyerSupportScene.handleOrderSelection(ctx, ctx.match[1]);
    } catch (err) {
      logger.error(`[SupportRoutes] sup:ord error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка выбора заказа').catch(() => {});
    }
  });

  bot.action(/^sup:my:(\d+)$/, async (ctx) => {
    try {
      await buyerSupportScene.showMyTickets(ctx, parseInt(ctx.match[1], 10));
    } catch (err) {
      logger.error(`[SupportRoutes] sup:my error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка загрузки тикетов').catch(() => {});
    }
  });

  bot.action(/^sup:v:([a-f0-9]{24})$/, async (ctx) => {
    try {
      await buyerSupportScene.showTicketDetail(ctx, ctx.match[1]);
    } catch (err) {
      logger.error(`[SupportRoutes] sup:v error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка загрузки тикета').catch(() => {});
    }
  });

  bot.action(/^sup:re:([a-f0-9]{24})$/, async (ctx) => {
    try {
      await buyerSupportScene.startBuyerReply(ctx, ctx.match[1]);
    } catch (err) {
      logger.error(`[SupportRoutes] sup:re error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка').catch(() => {});
    }
  });

  bot.action(/^sup:cl:([a-f0-9]{24})$/, async (ctx) => {
    try {
      await buyerSupportScene.closeByBuyer(ctx, ctx.match[1]);
    } catch (err) {
      logger.error(`[SupportRoutes] sup:cl error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка закрытия тикета').catch(() => {});
    }
  });

  bot.action(/^sup:rt:([a-f0-9]{24}):([1-5])$/, async (ctx) => {
    try {
      await buyerSupportScene.handleRating(ctx, ctx.match[1], parseInt(ctx.match[2], 10));
    } catch (err) {
      logger.error(`[SupportRoutes] sup:rt error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка сохранения оценки').catch(() => {});
    }
  });

  bot.action('sup:noop', (ctx) => ctx.answerCbQuery().catch(() => {}));

  // ─── СОТРУДНИКИ: ПАНЕЛЬ САППОРТА И ГРУППОВЫЕ КАРТОЧКИ (sp:*) ────────────────
  bot.action('sp:home', supportMiddleware, spGroupSecurityMiddleware, async (ctx) => {
    try {
      await supportPanelScene.showSupportPanel(ctx, 'waiting', 1);
    } catch (err) {
      logger.error(`[SupportRoutes] sp:home error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка загрузки панели').catch(() => {});
    }
  });

  bot.action('sp:duty', supportMiddleware, spGroupSecurityMiddleware, async (ctx) => {
    try {
      await supportPanelScene.toggleDuty(ctx);
    } catch (err) {
      logger.error(`[SupportRoutes] sp:duty error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка переключения смены').catch(() => {});
    }
  });

  bot.action(/^sp:q:(waiting|mine|esc|escalated|closed):(\d+)$/, supportMiddleware, spGroupSecurityMiddleware, async (ctx) => {
    try {
      await supportPanelScene.showSupportPanel(ctx, ctx.match[1], parseInt(ctx.match[2], 10));
    } catch (err) {
      logger.error(`[SupportRoutes] sp:q error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка загрузки очереди').catch(() => {});
    }
  });

  bot.action(/^sp:v:([a-f0-9]{24})$/, supportMiddleware, spGroupSecurityMiddleware, async (ctx) => {
    try {
      await supportPanelScene.showTicketForStaff(ctx, ctx.match[1]);
    } catch (err) {
      logger.error(`[SupportRoutes] sp:v error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка загрузки тикета').catch(() => {});
    }
  });

  bot.action(/^sp:take:([a-f0-9]{24})$/, supportMiddleware, spGroupSecurityMiddleware, async (ctx) => {
    try {
      await supportPanelScene.takeTicket(ctx, ctx.match[1]);
    } catch (err) {
      logger.error(`[SupportRoutes] sp:take error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка взятия тикета').catch(() => {});
    }
  });

  bot.action(/^sp:rep:([a-f0-9]{24})$/, supportMiddleware, spGroupSecurityMiddleware, async (ctx) => {
    try {
      await supportPanelScene.startStaffReply(ctx, ctx.match[1]);
    } catch (err) {
      logger.error(`[SupportRoutes] sp:rep error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка').catch(() => {});
    }
  });

  bot.action(/^sp:tpl:([a-f0-9]{24}):(\d+)$/, supportMiddleware, spGroupSecurityMiddleware, async (ctx) => {
    try {
      await supportPanelScene.sendQuickTemplate(ctx, ctx.match[1], parseInt(ctx.match[2], 10));
    } catch (err) {
      logger.error(`[SupportRoutes] sp:tpl error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка отправки шаблона').catch(() => {});
    }
  });

  bot.action(/^sp:esc:([a-f0-9]{24})$/, supportMiddleware, spGroupSecurityMiddleware, async (ctx) => {
    try {
      await supportPanelScene.startEscalate(ctx, ctx.match[1]);
    } catch (err) {
      logger.error(`[SupportRoutes] sp:esc error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка эскалации').catch(() => {});
    }
  });

  bot.action(/^sp:cls:([a-f0-9]{24})$/, supportMiddleware, spGroupSecurityMiddleware, async (ctx) => {
    try {
      await supportPanelScene.closeTicketByStaff(ctx, ctx.match[1]);
    } catch (err) {
      logger.error(`[SupportRoutes] sp:cls error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка закрытия тикета').catch(() => {});
    }
  });

  bot.action(/^sp:hist:([a-f0-9]{24}):(\d+)$/, supportMiddleware, spGroupSecurityMiddleware, async (ctx) => {
    try {
      await supportPanelScene.showTicketHistory(ctx, ctx.match[1], parseInt(ctx.match[2], 10));
    } catch (err) {
      logger.error(`[SupportRoutes] sp:hist error: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Ошибка загрузки истории').catch(() => {});
    }
  });

  bot.action('sp:noop', supportMiddleware, (ctx) => ctx.answerCbQuery().catch(() => {}));

  // ─── REPLY В ГРУППОВОМ ЧАТЕ САППОРТОВ НА КАРТОЧКУ БОТА ─────────────────────
  bot.on(['text', 'photo', 'video', 'document'], async (ctx, next) => {
    try {
      if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
        const handled = await supportPanelScene.handleGroupReply(ctx);
        if (handled) return;
      }
    } catch (err) {
      logger.error(`[SupportRoutes] group reply error: ${err.message}`);
    }
    return next();
  });
};
