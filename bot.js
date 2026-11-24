
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);

if (!TOKEN) throw new Error('BOT_TOKEN is missing');
if (!ADMIN_ID) throw new Error('ADMIN_ID is missing');

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

const EMOJI = {
  bag: '5019626126780138240',
  stop: '5017122105011995219',
  blue: '5017077798129369907',
  cross: '5019523782004441717',
  check: '5021905410089550576',
  tv: '4927197721900614739',
  star: '4976558436708778794',
  star2: '5152618775488496211',
  crown: '5156877291397055163',
  party: '4996755833950831347'
};

const premium = (id) => `<tg-emoji emoji-id="${id}">✨</tg-emoji>`;

const users = new Map();
const orders = [];
const sessions = new Map();
let nextOrderId = 1000;

const products = [
  ['premium', '💎 تلگرام پرمیوم'],
  ['stars', '⭐ تلگرام استارز'],
  ['ton', '💠 خدمات TON'],
  ['tron', '🔷 خدمات TRON'],
  ['gifts', '🎁 گیفت و NFT'],
  ['post', '📣 استارز روی پست']
];

function getUser(id, name = 'کاربر') {
  if (!users.has(id)) {
    users.set(id, {
      id,
      name,
      balance: 100,
      points: 0,
      lastSpin: '',
      orders: []
    });
  }
  return users.get(id);
}

function menu() {
  return {
    inline_keyboard: [
      [{ text: '🛍️ فروشگاه', callback_data: 'shop' }],
      [
        { text: '👤 حساب من', callback_data: 'account' },
        { text: '📦 سفارش‌ها', callback_data: 'orders' }
      ],
      [
        { text: '🎮 بازی‌ها', callback_data: 'games' },
        { text: '🎧 پشتیبانی', callback_data: 'support' }
      ]
    ]
  };
}

function back() {
  return {
    inline_keyboard: [
      [{ text: '🔙 بازگشت به خانه', callback_data: 'home' }]
    ]
  };
}

async function panel(chatId, messageId, text, keyboard) {
  const options = {
    parse_mode: 'HTML',
    reply_markup: keyboard || back()
  };

  if (messageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...options
      });
      return;
    } catch (e) {
      if (!String(e.message).includes('message is not modified')) {
        // If editing fails, send a new message.
      } else {
        return;
      }
    }
  }

  await bot.sendMessage(chatId, text, options);
}

function homeText(name) {
  return `${premium(EMOJI.party)}
<b>PREMIO CLUB</b>

سلام ${name}! 💜
به دنیای پرمیو خوش اومدی.

${premium(EMOJI.star2)} فروشگاه، بازی و خدمات ویژه
یکی از گزینه‌ها رو انتخاب کن:`;
}

function isAdmin(id) {
  return Number(id) === ADMIN_ID;
}

bot.onText(/^\/start$/, async (msg) => {
  const user = getUser(msg.from.id, msg.from.first_name);
  await bot.sendMessage(msg.chat.id, homeText(user.name), {
    parse_mode: 'HTML',
    reply_markup: menu()
  });
});

bot.onText(/^\/admin$/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  await showAdmin(msg.chat.id);
});

async function showAdmin(chatId, messageId) {
  const pending = orders.filter(o => o.status === 'در انتظار');
  const text = `${premium(EMOJI.crown)}
<b>PREMIO ADMIN PANEL</b>

👥 تعداد کاربران: ${users.size}
📦 کل سفارش‌ها: ${orders.length}
⏳ سفارش‌های در انتظار: ${pending.length}

مدیریت پرمیو:`;

  await panel(chatId, messageId, text, {
    inline_keyboard: [
      [{ text: '📦 سفارش‌های اخیر', callback_data: 'admin_orders' }],
      [{ text: '👥 کاربران', callback_data: 'admin_users' }],
      [{ text: '💰 راهنمای افزایش موجودی', callback_data: 'admin_credit' }],
      [{ text: '🏠 منوی اصلی', callback_data: 'home' }]
    ]
  });
}

bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;
  const userId = q.from.id;
  const user = getUser(userId, q.from.first_name);
  const data = q.data;

  await bot.answerCallbackQuery(q.id).catch(() => {});

  if (data === 'home') {
    sessions.delete(userId);
    return panel(chatId, messageId, homeText(user.name), menu());
  }

  if (data === 'shop') {
    const keyboard = products.map(([id, label]) => [
      { text: label, callback_data: `product_${id}` }
    ]);
    keyboard.push([{ text: '🔙 بازگشت', callback_data: 'home' }]);

    return panel(chatId, messageId,
      `${premium(EMOJI.bag)}
<b>فروشگاه PREMIO</b>

خدمات موردنظرت رو انتخاب کن:`,
      { inline_keyboard: keyboard });
  }

  if (data.startsWith('product_')) {
    const product = products.find(p => p[0] === data.slice(8));
    if (!product) return;

    sessions.set(userId, { type: 'order', product: product[1] });

    return panel(chatId, messageId,
      `${premium(EMOJI.star)}
<b>${product[1]}</b>

برای ثبت درخواست، دکمه زیر رو بزن.
بعدش می‌تونی توضیحاتت رو برای ادمین ارسال کنی.`,
      {
        inline_keyboard: [
          [{ text: '📝 ثبت درخواست', callback_data: 'create_order' }],
          [{ text: '🔙 برگشت به فروشگاه', callback_data: 'shop' }]
        ]
      });
  }

  if (data === 'create_order') {
    const session = sessions.get(userId);
    if (!session || session.type !== 'order') return;

    const order = {
      id: nextOrderId++,
      userId,
      name: user.name,
      product: session.product,
      status: 'در انتظار',
      note: '',
      date: new Date().toLocaleString('fa-IR')
    };

    orders.push(order);
    user.orders.push(order.id);
    sessions.set(userId, { type: 'order_note', orderId: order.id });

    await bot.sendMessage(ADMIN_ID,
      `📦 <b>درخواست جدید PREMIO</b>\n\n` +
      `شماره: #${order.id}\n` +
      `محصول: ${order.product}\n` +
      `کاربر: ${user.name}\n` +
      `شناسه: <code>${userId}</code>`,
      { parse_mode: 'HTML' });

    return panel(chatId, messageId,
      `${premium(EMOJI.check)}
<b>درخواست ثبت شد!</b>

شماره سفارش: <code>#${order.id}</code>

اگر توضیحی داری همین حالا در یک پیام بفرست؛ در غیر این صورت به منوی اصلی برگرد.`,
      back());
  }

  if (data === 'account') {
    return panel(chatId, messageId,
      `${premium(EMOJI.star2)}
<b>حساب کاربری شما</b>

👤 نام: ${user.name}
🆔 شناسه: <code>${userId}</code>
💰 اعتبار مجازی: ${user.balance}
⭐ امتیاز بازی: ${user.points}
📦 تعداد سفارش‌ها: ${user.orders.length}

<i>اعتبار و امتیاز فعلاً مجازی و آزمایشی هستند.</i>`,
      back());
  }

  if (data === 'orders') {
    const list = user.orders.map(id => {
      const o = orders.find(x => x.id === id);
      return o ? `#${o.id} — ${o.product}\nوضعیت: ${o.status}` : '';
    }).filter(Boolean);

    return panel(chatId, messageId,
      `${premium(EMOJI.bag)}
<b>سفارش‌های من</b>

${list.length ? list.join('\n\n') : 'هنوز سفارشی ثبت نکردی.'}`,
      back());
  }

  if (data === 'games') {
    return panel(chatId, messageId,
      `${premium(EMOJI.party)}
<b>بازی‌های PREMIO</b>

🎡 گردونه شانس: یک بار در روز
🚀 موشک پرمیو: بازی با امتیاز مجازی

موجودی مجازی: ${user.balance}`,
      {
        inline_keyboard: [
          [{ text: '🎡 چرخاندن گردونه', callback_data: 'spin' }],
          [{ text: '🚀 شروع موشک', callback_data: 'rocket' }],
          [{ text: '🔙 بازگشت', callback_data: 'home' }]
        ]
      });
  }

  if (data === 'spin') {
    const today = new Date().toISOString().slice(0, 10);
    if (user.lastSpin === today) {
      return panel(chatId, messageId,
        '⏳ امروز گردونه رو چرخوندی! فردا دوباره امتحان کن.',
        back());
    }

    const prize = [5, 10, 15, 20, 30, 50][Math.floor(Math.random() * 6)];
    user.lastSpin = today;
    user.points += prize;

    return panel(chatId, messageId,
      `${premium(EMOJI.party)}
<b>تبریک! گردونه چرخید!</b>

🎉 ${prize} امتیاز مجازی برنده شدی!

امتیاز فعلی: ${user.points}`,
      back());
  }

  if (data === 'rocket') {
    return panel(chatId, messageId,
      `${premium(EMOJI.tv)}
<b>موشک پرمیو</b>

برای شروع، ۱۰ امتیاز مجازی هزینه می‌کنی.
این بازی آزمایشی است و جایزه نقدی یا قابل برداشت ندارد.

امتیاز فعلی: ${user.points}`,
      {
        inline_keyboard: [
          [{ text: '🚀 پرواز!', callback_data: 'rocket_play' }],
          [{ text: '🔙 بازگشت', callback_data: 'games' }]
        ]
      });
  }

  if (data === 'rocket_play') {
    if (user.points < 10) {
      return panel(chatId, messageId,
        '❌ امتیاز کافی نداری. اول گردونه رو امتحان کن!',
        back());
    }

    user.points -= 10;
    const win = Math.random() < 0.45;
    const prize = win ? 25 : 0;
    user.points += prize;

    return panel(chatId, messageId,
      win
        ? `${premium(EMOJI.check)}\n<b>موفق شدی!</b>\n\n۲۵ امتیاز مجازی گرفتی.`
        : `${premium(EMOJI.cross)}\n<b>موشک سقوط کرد!</b>\n\n۱۰ امتیاز مجازی از دست رفت.`,
      back());
  }

  if (data === 'support') {
    sessions.set(userId, { type: 'support' });
    return panel(chatId, messageId,
      `${premium(EMOJI.star)}
<b>پشتیبانی PREMIO</b>

پیامت رو به صورت یک پیام معمولی ارسال کن تا برای ادمین فرستاده بشه.`,
      back());
  }

  if (data === 'admin') {
    if (!isAdmin(userId)) return;
    return showAdmin(chatId, messageId);
  }

  if (data === 'admin_orders') {
    if (!isAdmin(userId)) return;

    const recent = orders.slice(-10).reverse();
    const text = recent.length
      ? recent.map(o => `#${o.id} | ${o.product}\nکاربر: ${o.name} (${o.userId})\nوضعیت: ${o.status}`).join('\n\n')
      : 'هنوز سفارشی ثبت نشده.';

    const buttons = recent.map(o => [
      { text: `✅ تکمیل #${o.id}`, callback_data: `done_${o.id}` },
      { text: `❌ لغو #${o.id}`, callback_data: `cancel_${o.id}` }
    ]);
    buttons.push([{ text: '🔙 پنل مدیریت', callback_data: 'admin' }]);

    return panel(chatId, messageId,
      `${premium(EMOJI.crown)}
<b>سفارش‌های اخیر</b>

${text}`,
      { inline_keyboard: buttons });
  }

  if (data === 'admin_users') {
    if (!isAdmin(userId)) return;

    const list = [...users.values()].slice(-15).map(u =>
      `${u.name} — <code>${u.id}</code> — اعتبار: ${u.balance}`
    ).join('\n');

    return panel(chatId, messageId,
      `${premium(EMOJI.crown)}
<b>کاربران اخیر</b>

${list || 'هنوز کاربری وجود ندارد.'}`,
      back());
  }

  if (data === 'admin_credit') {
    if (!isAdmin(userId)) return;
    return panel(chatId, messageId,
      `<b>افزایش اعتبار آزمایشی</b>

برای افزایش اعتبار یک کاربر، این دستور رو ارسال کن:

<code>/credit USER_ID AMOUNT</code>

مثال:
<code>/credit 123456789 100</code>`,
      back());
  }

  if (data.startsWith('done_') || data.startsWith('cancel_')) {
    if (!isAdmin(userId)) return;

    const id = Number(data.split('_')[1]);
    const order = orders.find(o => o.id === id);
    if (!order) return;

    order.status = data.startsWith('done_') ? 'تکمیل شده' : 'لغو شده';

    await bot.sendMessage(order.userId,
      `📦 وضعیت سفارش #${id} تغییر کرد:\n${order.status}`);

    return showAdmin(chatId, messageId);
  }
});

bot.onText(/^\/credit (\d+) (\d+)$/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;

  const target = Number(match[1]);
  const amount = Number(match[2]);

  if (amount < 1 || amount > 1000000) {
    return bot.sendMessage(msg.chat.id, 'مبلغ معتبر نیست.');
  }

  const user = getUser(target);
  user.balance += amount;

  await bot.sendMessage(msg.chat.id,
    `✅ ${amount} اعتبار مجازی به کاربر ${target} اضافه شد.`);

  await bot.sendMessage(target,
    `💜 ${amount} اعتبار مجازی به حساب آزمایشی شما اضافه شد.`
  ).catch(() => {});
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const userId = msg.from.id;
  const session = sessions.get(userId);
  if (!session) return;

  if (session.type === 'support') {
    await bot.sendMessage(ADMIN_ID,
      `🎧 <b>پیام پشتیبانی جدید</b>\n\n` +
      `از: ${msg.from.first_name}\n` +
      `شناسه: <code>${userId}</code>\n\n` +
      `${msg.text}`,
      { parse_mode: 'HTML' });

    return bot.sendMessage(msg.chat.id,
      '✅ پیامت برای پشتیبانی ارسال شد.');
  }

  if (session.type === 'order_note') {
    const order = orders.find(o => o.id === session.orderId);
    if (!order) return;

    order.note = msg.text;

    await bot.sendMessage(ADMIN_ID,
      `📝 توضیحات سفارش #${order.id}\n\n${msg.text}`);

    sessions.delete(userId);
    return bot.sendMessage(msg.chat.id,
      '✅ توضیحاتت برای ادمین ارسال شد.');
  }
});

bot.onText(/^\/reply (\d+) (.+)$/s, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;

  const target = Number(match[1]);
  const answer = match[2];

  try {
    await bot.sendMessage(target,
      `🎧 <b>پاسخ پشتیبانی PREMIO</b>\n\n${answer}`,
      { parse_mode: 'HTML' });

    await bot.sendMessage(msg.chat.id, '✅ پاسخ ارسال شد.');
  } catch (e) {
    await bot.sendMessage(msg.chat.id, '❌ ارسال پیام انجام نشد.');
  }
});

app.get('/', (req, res) => {
  res.send('PREMIO BOT is running 💜');
});

app.listen(process.env.PORT || 3000, () => {
  console.log('PREMIO BOT is running');
});
