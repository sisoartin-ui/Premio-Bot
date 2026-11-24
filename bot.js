
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN is missing');

const bot = new TelegramBot(token, { polling: true });
const app = express();

const keyboard = {
  inline_keyboard: [
    [{ text: '🛍️ فروشگاه', callback_data: 'shop' }],
    [
      { text: '👤 حساب کاربری', callback_data: 'account' },
      { text: '📦 سفارش‌های من', callback_data: 'orders' }
    ],
    [{ text: '🎧 پشتیبانی', callback_data: 'support' }]
  ]
};

bot.onText(/^\/start$/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'سلام! 💜\nبه پرمیو خوش اومدی!\n\nبرای شروع یکی از گزینه‌های زیر رو انتخاب کن:',
    { reply_markup: keyboard }
  );
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const id = query.id;

  const panels = {
    shop: '🛍️ فروشگاه پرمیو\nبه‌زودی دسته‌بندی محصولات اینجا نمایش داده می‌شه.',
    account: '👤 حساب کاربری\nاطلاعات حساب شما اینجا نمایش داده می‌شه.',
    orders: '📦 سفارش‌های من\nهنوز سفارشی ثبت نشده است.',
    support: '🎧 پشتیبانی پرمیو\nبرای ارتباط با پشتیبانی پیام خودت رو ارسال کن.'
  };

  const text = panels[query.data];

  if (text) {
    await bot.answerCallbackQuery(id);
    await bot.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'home' }]
        ]
      }
    });
  } else if (query.data === 'home') {
    await bot.answerCallbackQuery(id);
    await bot.sendMessage(chatId, '💜 منوی اصلی پرمیو', {
      reply_markup: keyboard
    });
  }
});

app.get('/', (req, res) => res.send('PREMIO BOT is running 💜'));

app.listen(process.env.PORT || 3000, () => {
  console.log('PREMIO BOT is running');
});
