
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const DATABASE_URL = process.env.DATABASE_URL;

if (!TOKEN || !ADMIN_ID || !DATABASE_URL) {
  console.error("Missing BOT_TOKEN, ADMIN_ID or DATABASE_URL");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false"
    ? false
    : { rejectUnauthorized: false }
});

// مدیریت مراحل گفتگو؛ فقط یک بار تعریف شده است
const sessions = new Map();

const isAdmin = id => String(id) === ADMIN_ID;
const money = n => Number(n || 0).toLocaleString("en-US") + " تومان";

const esc = value => String(value ?? "").replace(/[&<>"]/g, char => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
}[char]));

const kb = rows => ({ inline_keyboard: rows });

const homeKeyboard = kb([
  [
    { text: "🛍 فروشگاه", callback_data: "shop" },
    { text: "👛 کیف پول", callback_data: "wallet" }
  ],
  [
    { text: "🎮 بازی‌ها", callback_data: "games" },
    { text: "📦 سفارش‌های من", callback_data: "orders" }
  ],
  [
    { text: "🎁 دعوت دوستان", callback_data: "ref" },
    { text: "🎟 کد تخفیف", callback_data: "coupon" }
  ],
  [{ text: "💬 پشتیبانی", callback_data: "support" }]
]);

const services = [
  ["stars", "⭐ تلگرام استارز"],
  ["premium", "🌟 تلگرام پرمیوم"],
  ["ton", "💎 ارز TON"],
  ["tron", "🪙 ارز TRON"],
  ["gift", "🎁 گیفت و NFT"],
  ["poststars", "📣 استارز روی پست"]
];

async function query(sql, params = []) {
  return (await pool.query(sql, params)).rows;
}

async function initDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      toman BIGINT NOT NULL DEFAULT 0,
      stars BIGINT NOT NULL DEFAULT 0,
      xp BIGINT NOT NULL DEFAULT 0,
      level INT NOT NULL DEFAULT 1,
      referred_by BIGINT,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      service TEXT NOT NULL,
      details TEXT,
      amount BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      wallet TEXT NOT NULL,
      amount BIGINT NOT NULL,
      destination TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS coupons (
      code TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      value BIGINT NOT NULL,
      uses_left INT,
      expires_at TIMESTAMPTZ,
      active BOOLEAN DEFAULT true
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS coupon_uses (
      code TEXT REFERENCES coupons(code),
      user_id BIGINT REFERENCES users(id),
      PRIMARY KEY(code, user_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS channels (
      chat_id TEXT PRIMARY KEY,
      title TEXT,
      url TEXT NOT NULL,
      active BOOLEAN DEFAULT true
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id),
      message TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS referral_rewards (
      order_id BIGINT PRIMARY KEY REFERENCES orders(id),
      referrer_id BIGINT NOT NULL,
      amount BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await query(`
    INSERT INTO settings(key, value)
    VALUES ('ref_signup', '1500'), ('ref_purchase', '10000')
    ON CONFLICT(key) DO NOTHING
  `);
}

async function getUser(id) {
  return (await query("SELECT * FROM users WHERE id=$1", [String(id)]))[0];
}

async function ensureUser(from, refId) {
  const id = String(from.id);
  const existing = await getUser(id);

  if (existing) {
    await query(
      "UPDATE users SET username=$2, first_name=$3 WHERE id=$1",
      [id, from.username || null, from.first_name || ""]
    );
    return;
  }

  let validRef = null;

  if (refId && String(refId) !== id) {
    const referrer = await getUser(String(refId));
    if (referrer) validRef = String(refId);
  }

  const inserted = await query(
    `INSERT INTO users(id, username, first_name, referred_by)
     VALUES($1, $2, $3, $4)
     ON CONFLICT(id) DO NOTHING
     RETURNING id`,
    [id, from.username || null, from.first_name || "", validRef]
  );

  if (inserted.length && validRef) {
    const reward = Number(
      (await query("SELECT value FROM settings WHERE key='ref_signup'"))[0]?.value || 0
    );

    if (reward > 0) {
      await query(
        "UPDATE users SET toman=toman+$2 WHERE id=$1",
        [validRef, reward]
      );
    }
  }
}

async function membershipMissing(userId) {
  const channels = await query(
    "SELECT * FROM channels WHERE active=true"
  );

  const missing = [];

  for (const channel of channels) {
    try {
      const member = await bot.getChatMember(channel.chat_id, userId);

      if (!["member", "administrator", "creator"].includes(member.status)) {
        missing.push(channel);
      }
    } catch {
      missing.push(channel);
    }
  }

  return missing;
}

async function showJoinPrompt(chatId, missing) {
  const rows = missing.map(channel => [{
    text: "عضویت در " + (channel.title || "کانال"),
    url: channel.url
  }]);

  rows.push([{ text: "🔄 بررسی عضویت", callback_data: "checkjoin" }]);

  return bot.sendMessage(
    chatId,
    "برای استفاده از ربات، ابتدا در کانال‌های زیر عضو شو:",
    { reply_markup: kb(rows) }
  );
}

async function editPanel(chatId, messageId, text, keyboard = homeKeyboard) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: keyboard
    });
  } catch {
    return bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: keyboard
    });
  }
}

function adminKeyboard() {
  return kb([
    [
      { text: "📦 سفارش‌های در انتظار", callback_data: "adm_orders" },
      { text: "💸 درخواست‌های برداشت", callback_data: "adm_withdraw" }
    ],
    [
      { text: "👥 کاربران", callback_data: "adm_users" },
      { text: "📊 گزارش", callback_data: "adm_report" }
    ],
    [
      { text: "➕ افزایش موجودی", callback_data: "adm_credit" },
      { text: "📣 کانال اجباری", callback_data: "adm_channels" }
    ],
    [
      { text: "🎟 ساخت کد تخفیف", callback_data: "adm_coupon" },
      { text: "🏠 خانه", callback_data: "home" }
    ]
  ]);
}

async function notifyAdmin(text, keyboard) {
  return bot.sendMessage(ADMIN_ID, text, {
    parse_mode: "HTML",
    ...(keyboard ? { reply_markup: keyboard } : {})
  });
}

// شروع ربات
bot.onText(/^\/start(?:\s+(\d+))?$/, async (msg, match) => {
  try {
    await ensureUser(msg.from, match?.[1]);

    const missing = await membershipMissing(msg.from.id);
    if (missing.length) {
      return showJoinPrompt(msg.chat.id, missing);
    }

    return bot.sendMessage(
      msg.chat.id,
      `✨ <b>به PREMIO خوش اومدی، ${esc(msg.from.first_name)}!</b>\n\nخرید سریع، کیف پول و خدمات تلگرام در یک جا.`,
      { parse_mode: "HTML", reply_markup: homeKeyboard }
    );
  } catch (error) {
    console.error("Start error:", error);
    bot.sendMessage(msg.chat.id, "خطایی رخ داد. کمی بعد دوباره تلاش کن.");
  }
});

// منوی ادمین
bot.onText(/^\/admin$/, async msg => {
  if (!isAdmin(msg.from.id)) return;

  return bot.sendMessage(
    msg.chat.id,
    "🛠 <b>پنل مدیریت PREMIO</b>",
    { parse_mode: "HTML", reply_markup: adminKeyboard() }
  );
});

// دکمه‌ها
bot.on("callback_query", async cq => {
  const userId = String(cq.from.id);
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const data = cq.data;

  try {
    await bot.answerCallbackQuery(cq.id);

    if (!isAdmin(userId) && data !== "checkjoin") {
      const missing = await membershipMissing(userId);
      if (missing.length) return showJoinPrompt(chatId, missing);
    }

    if (data === "checkjoin") {
      const missing = await membershipMissing(userId);

      if (missing.length) return showJoinPrompt(chatId, missing);

      return editPanel(chatId, messageId, "✅ عضویت تأیید شد.", homeKeyboard);
    }

    if (data === "home") {
      return editPanel(chatId, messageId, "✨ <b>منوی اصلی PREMIO</b>", homeKeyboard);
    }

    if (data === "shop") {
      return editPanel(
        chatId,
        messageId,
        "🛍 <b>فروشگاه PREMIO</b>\nیکی از خدمات را انتخاب کن:",
        kb([
          ...services.map(service => [{
            text: service[1],
            callback_data: "buy_" + service[0]
          }]),
          [{ text: "⬅️ بازگشت", callback_data: "home" }]
        ])
      );
    }

    if (data.startsWith("buy_")) {
      const service = services.find(item => "buy_" + item[0] === data);
      if (!service) return;

      sessions.set(userId, {
        step: "order_details",
        service: service[0]
      });

      return editPanel(
        chatId,
        messageId,
        `🧾 <b>${service[1]}</b>\n\nجزئیات سفارش را در یک پیام بفرست.\nمثال: تعداد، شناسه گیرنده یا مدت اشتراک.`,
        kb([[{ text: "لغو", callback_data: "shop" }]])
      );
    }

    if (data === "wallet") {
      const user = await getUser(userId);

      return editPanel(
        chatId,
        messageId,
        `👛 <b>کیف پول شما</b>\n\n💰 موجودی تومان: <b>${money(user.toman)}</b>\n⭐ موجودی استارزی: <b>${Number(user.stars).toLocaleString("en-US")}</b>\n\nدرخواست برداشت پس از بررسی ادمین تأیید یا رد می‌شود.`,
        kb([
          [{ text: "💸 برداشت تومان", callback_data: "withdraw_toman" }],
          [{ text: "⭐ برداشت استارز", callback_data: "withdraw_stars" }],
          [{ text: "🏠 خانه", callback_data: "home" }]
        ])
      );
    }

    if (data === "withdraw_toman" || data === "withdraw_stars") {
      sessions.set(userId, {
        step: "withdraw_amount",
        wallet: data === "withdraw_toman" ? "toman" : "stars"
      });

      return editPanel(
        chatId,
        messageId,
        "مقدار برداشت را به عدد وارد کن:",
        kb([[{ text: "لغو", callback_data: "wallet" }]])
      );
    }

    if (data === "orders") {
      const rows = await query(
        "SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC LIMIT 10",
        [userId]
      );

      const text = rows.length
        ? "📦 <b>سفارش‌های شما</b>\n" +
          rows.map(order =>
            `#${order.id} | ${esc(order.service)} | ${esc(order.status)}`
          ).join("\n")
        : "هنوز سفارشی ثبت نکردی.";

      return editPanel(
        chatId,
        messageId,
        text,
        kb([[{ text: "🏠 خانه", callback_data: "home" }]])
      );
    }

    if (data === "games") {
      return editPanel(
        chatId,
        messageId,
        "🎮 <b>بازی‌های PREMIO</b>\n\nبازی‌ها هنوز فعال نشده‌اند. موجودی اولیه همه کاربران صفر است و هیچ امتیاز آزمایشی وجود ندارد.",
        kb([
          [{ text: "🎡 گردونه روزانه", callback_data: "spin" }],
          [{ text: "🚀 موشک", callback_data: "rocket" }],
          [{ text: "🏠 خانه", callback_data: "home" }]
        ])
      );
    }

    if (data === "spin" || data === "rocket") {
      return editPanel(
        chatId,
        messageId,
        "این بازی هنوز پیاده‌سازی نشده است.",
        kb([[{ text: "🎮 بازی‌ها", callback_data: "games" }]])
      );
    }

    if (data === "ref") {
      const me = await bot.getMe();

      return editPanel(
        chatId,
        messageId,
        `🎁 <b>دعوت دوستان</b>\n\nلینک اختصاصی شما:\nhttps://t.me/${me.username}?start=${userId}\n\nپاداش ثبت‌نام: ۱٬۵۰۰ تومان اعتبار.\nپاداش خرید موفق دعوت‌شده: ۱۰٬۰۰۰ تومان.`,
        kb([[{ text: "🏠 خانه", callback_data: "home" }]])
      );
    }

    if (data === "coupon") {
      sessions.set(userId, { step: "coupon" });

      return editPanel(
        chatId,
        messageId,
        "کد تخفیف را بفرست:",
        kb([[{ text: "لغو", callback_data: "home" }]])
      );
    }

    if (data === "support") {
      sessions.set(userId, { step: "support" });

      return editPanel(
        chatId,
        messageId,
        "پیامت برای پشتیبانی را بفرست:",
        kb([[{ text: "لغو", callback_data: "home" }]])
      );
    }

    // فقط ادمین اجازه دسترسی به بخش‌های مدیریتی را دارد
    if (data === "admin" && isAdmin(userId)) {
      return editPanel(chatId, messageId, "🛠 <b>پنل مدیریت PREMIO</b>", adminKeyboard());
    }

    if (!isAdmin(userId)) return;

    if (data === "adm_orders") {
      const rows = await query(
        "SELECT * FROM orders WHERE status='pending' ORDER BY id LIMIT 15"
      );

      if (!rows.length) {
        return editPanel(chatId, messageId, "سفارش در انتظار وجود ندارد.", adminKeyboard());
      }

      for (const order of rows) {
        await bot.sendMessage(
          chatId,
          `📦 سفارش #${order.id}\nکاربر: ${order.user_id}\nخدمت: ${esc(order.service)}\nجزئیات: ${esc(order.details || "")}`,
          {
            parse_mode: "HTML",
            reply_markup: kb([[
              { text: "✅ تکمیل", callback_data: `ord_ok_${order.id}` },
              { text: "❌ رد", callback_data: `ord_no_${order.id}` }
            ]])
          }
        );
      }

      return;
    }

    if (data === "adm_withdraw") {
      const rows = await query(
        "SELECT * FROM withdrawals WHERE status='pending' ORDER BY id LIMIT 15"
      );

      if (!rows.length) {
        return editPanel(chatId, messageId, "درخواست برداشت در انتظار وجود ندارد.", adminKeyboard());
      }

      for (const item of rows) {
        await bot.sendMessage(
          chatId,
          `💸 درخواست برداشت #${item.id}\nکاربر: ${item.user_id}\nکیف پول: ${item.wallet}\nمقدار: ${item.amount}\nمقصد: ${esc(item.destination)}`,
          {
            parse_mode: "HTML",
            reply_markup: kb([[
              { text: "✅ تأیید", callback_data: `wd_ok_${item.id}` },
              { text: "❌ رد", callback_data: `wd_no_${item.id}` }
            ]])
          }
        );
      }

      return;
    }

    if (data === "adm_users") {
      const rows = await query(
        "SELECT id, username, toman, stars FROM users ORDER BY created_at DESC LIMIT 15"
      );

      const text = rows.map(user =>
        `${user.id} @${user.username || "-"} | ${money(user.toman)} | ⭐ ${user.stars}`
      ).join("\n") || "کاربری وجود ندارد.";

      return editPanel(chatId, messageId, text, adminKeyboard());
    }

    if (data === "adm_report") {
      const report = (await query(`
        SELECT count(*) AS users,
        (SELECT count(*) FROM orders) AS orders,
        (SELECT count(*) FROM orders WHERE status='completed') AS completed
        FROM users
      `))[0];

      return editPanel(
        chatId,
        messageId,
        `📊 کاربران: ${report.users}\nکل سفارش‌ها: ${report.orders}\nتکمیل‌شده: ${report.completed}`,
        adminKeyboard()
      );
    }

    if (data === "adm_credit") {
      sessions.set(userId, { step: "credit_id" });
      return editPanel(chatId, messageId, "آیدی عددی کاربر را بفرست:", adminKeyboard());
    }

    if (data === "adm_coupon") {
      sessions.set(userId, { step: "coupon_create_code" });
      return editPanel(chatId, messageId, "نام کد تخفیف را بفرست:", adminKeyboard());
    }

    if (data === "adm_channels") {
      sessions.set(userId, { step: "channel_add" });

      return editPanel(
        chatId,
        messageId,
        "برای افزودن کانال، در یک پیام بفرست:\nchat_id | عنوان | لینک دعوت\n\nربات باید در کانال ادمین باشد.",
        adminKeyboard()
      );
    }

    // تکمیل یا رد سفارش؛ فقط یک بار
    if (data.startsWith("ord_")) {
      const [, action, orderId] = data.split("_");
      const status = action === "ok" ? "completed" : "rejected";

      const updated = await query(
        `UPDATE orders SET status=$2
         WHERE id=$1 AND status='pending'
         RETURNING *`,
        [orderId, status]
      );

      if (!updated.length) {
        return bot.sendMessage(chatId, "این سفارش قبلاً بررسی شده است.");
      }

      const order = updated[0];

      if (status === "completed") {
        const referrer = await query(
          "SELECT referred_by FROM users WHERE id=$1",
          [order.user_id]
        );

        const refId = referrer[0]?.referred_by;

        if (refId) {
          const bonus = Number(
            (await query("SELECT value FROM settings WHERE key='ref_purchase'"))[0]?.value || 0
          );

          if (bonus > 0) {
            const reward = await query(
              `INSERT INTO referral_rewards(order_id,referrer_id,amount)
               VALUES($1,$2,$3)
               ON CONFLICT(order_id) DO NOTHING
               RETURNING order_id`,
              [order.id, refId, bonus]
            );

            if (reward.length) {
              await query(
                "UPDATE users SET toman=toman+$2 WHERE id=$1",
                [refId, bonus]
              );
              await bot.sendMessage(
                refId,
                `🎁 پاداش خرید موفق دعوت‌شده به کیف پول شما اضافه شد: ${money(bonus)}`
              );
            }
          }
        }
      }

      await bot.sendMessage(
        order.user_id,
        `وضعیت سفارش #${order.id}: ${status === "completed" ? "✅ تکمیل شد" : "❌ رد شد"}`
      );

      return bot.sendMessage(chatId, "وضعیت سفارش به‌روزرسانی شد.");
    }

    // برداشت: موجودی هنگام ثبت درخواست رزرو می‌شود
    if (data.startsWith("wd_")) {
      const [, action, withdrawalId] = data.split("_");
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const result = await client.query(
          `SELECT * FROM withdrawals
           WHERE id=$1 AND status='pending'
           FOR UPDATE`,
          [withdrawalId]
        );

        if (!result.rows.length) {
          await client.query("ROLLBACK");
          return bot.sendMessage(chatId, "این درخواست قبلاً بررسی شده است.");
        }

        const withdrawal = result.rows[0];

        if (action === "no") {
          const column = withdrawal.wallet === "toman" ? "toman" : "stars";

          await client.query(
            `UPDATE users SET ${column}=${column}+$2 WHERE id=$1`,
            [withdrawal.user_id, withdrawal.amount]
          );

          await client.query(
            "UPDATE withdrawals SET status='rejected' WHERE id=$1",
            [withdrawalId]
          );
        } else {
          await client.query(
            "UPDATE withdrawals SET status='approved' WHERE id=$1",
            [withdrawalId]
          );
        }

        await client.query("COMMIT");

        await bot.sendMessage(
          withdrawal.user_id,
          action === "ok"
            ? `✅ درخواست برداشت #${withdrawalId} تأیید شد. پرداخت را ادمین باید جداگانه انجام دهد.`
            : `❌ درخواست برداشت #${withdrawalId} رد شد و موجودی رزروشده به کیف پول برگشت.`
        );

        return bot.sendMessage(chatId, "درخواست برداشت بررسی شد.");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  } catch (error) {
    console.error("Callback error:", error);
    bot.sendMessage(chatId, "خطا در انجام عملیات. دوباره تلاش کن.");
  }
});

// پیام‌های متنی و مراحل ثبت اطلاعات
bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const userId = String(msg.from.id);
  const session = sessions.get(userId);

  if (!session) return;

  try {
    if (session.step === "order_details") {
      const order = (await query(
        `INSERT INTO orders(user_id, service, details)
         VALUES($1, $2, $3) RETURNING id`,
        [userId, session.service, msg.text]
      ))[0];

      sessions.delete(userId);

      await bot.sendMessage(
        msg.chat.id,
        `✅ درخواست شما با شماره #${order.id} ثبت شد و در انتظار بررسی ادمین است.`
      );

      await notifyAdmin(
        `🛍 سفارش جدید #${order.id}\nکاربر: ${userId}\nخدمت: ${session.service}\nجزئیات: ${esc(msg.text)}`,
        kb([[
          { text: "✅ تکمیل", callback_data: `ord_ok_${order.id}` },
          { text: "❌ رد", callback_data: `ord_no_${order.id}` }
        ]])
      );
    }

    else if (session.step === "withdraw_amount") {
      const amount = Number(msg.text);

      if (!Number.isSafeInteger(amount) || amount <= 0) {
        return bot.sendMessage(msg.chat.id, "عدد معتبر و بزرگ‌تر از صفر وارد کن.");
      }

      const column = session.wallet === "toman" ? "toman" : "stars";
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const result = await client.query(
          `UPDATE users SET ${column}=${column}-$2
           WHERE id=$1 AND ${column}>=$2
           RETURNING id`,
          [userId, amount]
        );

        if (!result.rows.length) {
          await client.query("ROLLBACK");
          return bot.sendMessage(msg.chat.id, "موجودی کافی نیست.");
        }

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      sessions.set(userId, {
        step: "withdraw_destination",
        wallet: session.wallet,
        amount
      });

      return bot.sendMessage(
        msg.chat.id,
        "مقصد دریافت را بفرست؛ مثلاً شماره کارت یا آدرس کیف پول:"
      );
    }

    else if (session.step === "withdraw_destination") {
      const withdrawal = (await query(
        `INSERT INTO withdrawals(user_id, wallet, amount, destination)
         VALUES($1, $2, $3, $4) RETURNING id`,
        [userId, session.wallet, session.amount, msg.text]
      ))[0];

      sessions.delete(userId);

      await bot.sendMessage(
        msg.chat.id,
        `درخواست برداشت #${withdrawal.id} ثبت شد. موجودی تا زمان بررسی ادمین رزرو شده است.`
      );

      await notifyAdmin(
        `💸 درخواست برداشت #${withdrawal.id}\nکاربر: ${userId}\nکیف پول: ${session.wallet}\nمبلغ: ${session.amount}\nمقصد: ${esc(msg.text)}`,
        kb([[
          { text: "✅ تأیید", callback_data: `wd_ok_${withdrawal.id}` },
          { text: "❌ رد", callback_data: `wd_no_${withdrawal.id}` }
        ]])
      );
    }

    else if (session.step === "support") {
      const ticket = (await query(
        "INSERT INTO tickets(user_id, message) VALUES($1, $2) RETURNING id",
        [userId, msg.text]
      ))[0];

      sessions.delete(userId);

      await bot.sendMessage(msg.chat.id, `پیامت ثبت شد. شماره تیکت: #${ticket.id}`);

      await notifyAdmin(
        `💬 تیکت #${ticket.id} از کاربر ${userId}:\n${esc(msg.text)}`
      );
    }

    else if (session.step === "coupon") {
      const code = msg.text.trim().toUpperCase();

      const coupon = (await query(
        `SELECT * FROM coupons
         WHERE code=$1 AND active=true
         AND (expires_at IS NULL OR expires_at>now())
         AND (uses_left IS NULL OR uses_left>0)`,
        [code]
      ))[0];

      if (!coupon) {
        return bot.sendMessage(msg.chat.id, "کد معتبر نیست یا منقضی شده است.");
      }

      try {
        await query(
          "INSERT INTO coupon_uses(code, user_id) VALUES($1, $2)",
          [code, userId]
        );
      } catch {
        return bot.sendMessage(msg.chat.id, "این کد را قبلاً استفاده کرده‌ای.");
      }

      if (coupon.uses_left !== null) {
        await query(
          "UPDATE coupons SET uses_left=uses_left-1 WHERE code=$1",
          [code]
        );
      }

      sessions.delete(userId);

      return bot.sendMessage(
        msg.chat.id,
        `🎟 کد پذیرفته شد: ${coupon.value}${coupon.kind === "percent" ? "٪" : " تومان"} تخفیف.`
      );
    }

    else if (session.step === "credit_id") {
      if (!/^\d+$/.test(msg.text)) {
        return bot.sendMessage(msg.chat.id, "آیدی عددی معتبر بفرست.");
      }

      const target = await getUser(msg.text);

      if (!target) {
        return bot.sendMessage(msg.chat.id, "این کاربر هنوز ربات را فعال نکرده است.");
      }

      sessions.set(userId, {
        step: "credit_toman",
        target: msg.text
      });

      return bot.sendMessage(msg.chat.id, "مقدار افزایش موجودی تومان را بفرست:");
    }

    else if (session.step === "credit_toman") {
      const amount = Number(msg.text);

      if (!Number.isSafeInteger(amount) || amount < 0) {
        return bot.sendMessage(msg.chat.id, "عدد معتبر و غیرمنفی وارد کن.");
      }

      await query(
        "UPDATE users SET toman=toman+$2 WHERE id=$1",
        [session.target, amount]
      );

      sessions.set(userId, {
        step: "credit_stars",
        target: session.target
      });

      return bot.sendMessage(msg.chat.id, "مقدار افزایش موجودی استارز را بفرست:");
    }

    else if (session.step === "credit_stars") {
      const amount = Number(msg.text);

      if (!Number.isSafeInteger(amount) || amount < 0) {
        return bot.sendMessage(msg.chat.id, "عدد معتبر و غیرمنفی وارد کن.");
      }

      await query(
        "UPDATE users SET stars=stars+$2 WHERE id=$1",
        [session.target, amount]
      );

      sessions.delete(userId);

      await bot.sendMessage(msg.chat.id, "✅ موجودی‌ها با موفقیت به‌روزرسانی شدند.");

      await bot.sendMessage(
        session.target,
        "موجودی کیف پول شما توسط مدیریت به‌روزرسانی شد."
      );
    }

    else if (session.step === "coupon_create_code") {
      const code = msg.text.trim().toUpperCase();

      if (!/^[A-Z0-9_-]{3,30}$/.test(code)) {
        return bot.sendMessage(msg.chat.id, "کد باید ۳ تا ۳۰ حرف انگلیسی یا عدد باشد.");
      }

      sessions.set(userId, {
        step: "coupon_create_value",
        code
      });

      return bot.sendMessage(msg.chat.id, "درصد تخفیف را بین ۱ تا ۱۰۰ وارد کن:");
    }

    else if (session.step === "coupon_create_value") {
      const value = Number(msg.text);

      if (!Number.isInteger(value) || value < 1 || value > 100) {
        return bot.sendMessage(msg.chat.id, "درصد باید بین ۱ تا ۱۰۰ باشد.");
      }

      await query(
        `INSERT INTO coupons(code, kind, value)
         VALUES($1, 'percent', $2)
         ON CONFLICT(code) DO UPDATE
         SET kind='percent', value=$2, active=true`,
        [session.code, value]
      );

      sessions.delete(userId);
      return bot.sendMessage(msg.chat.id, "✅ کد تخفیف ساخته شد.");
    }

    else if (session.step === "channel_add") {
      const parts = msg.text.split("|").map(part => part.trim());

      if (parts.length !== 3 || !parts[0] || !parts[2]) {
        return bot.sendMessage(
          msg.chat.id,
          "فرمت درست:\nchat_id | عنوان | لینک"
        );
      }

      await query(
        `INSERT INTO channels(chat_id, title, url)
         VALUES($1, $2, $3)
         ON CONFLICT(chat_id) DO UPDATE
         SET title=$2, url=$3, active=true`,
        parts
      );

      sessions.delete(userId);
      return bot.sendMessage(msg.chat.id, "✅ کانال اجباری ثبت شد.");
    }
  } catch (error) {
    console.error("Message error:", error);
    bot.sendMessage(msg.chat.id, "خطا رخ داد. دوباره تلاش کن.");
  }
});

bot.on("polling_error", error => {
  console.error("Telegram polling error:", error.message);
});

initDatabase()
  .then(() => console.log("PREMIO bot started successfully"))
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
