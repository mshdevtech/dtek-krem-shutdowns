import "dotenv/config";
import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { Redis } from "@upstash/redis";
import { Telegraf, Scenes, session } from "telegraf";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT ?? 3001);
const DTEK_URL = process.env.DTEK_URL;
const CITY = process.env.CITY;
const STREET = process.env.STREET;
const HOUSE = process.env.HOUSE;
const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const FRONTEND_URL = process.env.FRONTEND_URL;
const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

// ======================
// 🧠 Redis (Upstash)
// ======================
const redis = Redis.fromEnv();
const USERS_SET = "users";
const userKey = (chatId) => `user:${chatId}`;

async function getUser(chatId) {
    const data = await redis.get(userKey(chatId));
    return data ?? null;
}

async function saveUser(chatId, data) {
    await redis.set(userKey(chatId), data);
    await redis.sadd(USERS_SET, String(chatId));
}

// ======================
// 1️⃣ ДОПОМІЖНІ ФУНКЦІЇ
// ======================

// Закриття модалки
async function closeModal(page) {
    // 1) Спроба клікнути по кнопці закриття
    try {
        const btn = page.locator('[data-micromodal-close]').first();
        await btn.waitFor({ state: "visible", timeout: 5000 });
        await btn.click();
    } catch {}

    // 2) Якщо overlay ще є — прибрати його з DOM (fallback)
    try {
        await page.evaluate(() => {
            const overlay = document.querySelector(".modal__overlay");
            if (overlay) overlay.remove();
            document.body.style.overflow = "auto";
        });
    } catch {}
}


async function fillAutocomplete(page, inputSelector, value) {
    const field = page.locator(inputSelector).first();
    await field.waitFor({ state: "visible", timeout: 20000 });

    // дістаємо id інпута, щоб зібрати id списку
    const inputId = await field.getAttribute("id");
    if (!inputId) throw new Error(`Поле ${inputSelector} не має id, не можу знайти список автокомпліту`);

    const listSelector = `#${inputId}autocomplete-list.autocomplete-items`;
    const firstItemSelector = `${listSelector} > div`;

    // очистити та ввести
    await field.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await field.type(value, { delay: 40 });

    // чекати, поки зʼявиться список (без sleep)
    const list = page.locator(listSelector);
    await list.waitFor({ state: "visible", timeout: 10000 });

    const firstItem = page.locator(firstItemSelector).first();
    await firstItem.waitFor({ state: "visible", timeout: 10000 });

    // клік по першій опції (вона вставляє значення в інпут)
    await firstItem.click();

    // дочекатися, поки інпут реально заповниться
    await page.waitForFunction(
        (sel) => {
            const el = document.querySelector(sel);
            return el && (el.value || "").trim().length >= 2;
        },
        inputSelector,
        { timeout: 5000 }
    );

    const finalValue = (await field.inputValue()).trim();
    if (!finalValue || finalValue.length < 2) {
        throw new Error(`❌ Не вдалося вибрати зі списку для поля ${inputSelector}`);
    }
    return finalValue;
}

function cellClassToState(cls = "") {
    if (cls.includes("cell-non-scheduled")) return "ON";
    if (cls.includes("cell-scheduled")) return "OFF";
    if (cls.includes("cell-first-half")) return "OFF_FIRST_HALF";
    if (cls.includes("cell-second-half")) return "OFF_SECOND_HALF";
    if (cls.includes("cell-scheduled-maybe")) return "OFF_MAYBE";
    return "UNKNOWN";
}

async function readCurrentOutage(page) {
    const box = page.locator("#showCurOutage");
    await box.waitFor({ state: "visible", timeout: 20000 });

    const textRaw = (await box.innerText()).trim();
    const text = textRaw.replace(/\s+/g, " ");
    const lower = text.toLowerCase();

    // OFF-шаблон
    const isOff = lower.includes("в даний момент відсутня електроенергія") ||
        lower.includes("відсутня електроенергія");

    // Витягнемо strong (в OFF-шаблоні вони йдуть: причина, початок, відновлення)
    const strong = (await box.locator("strong").allInnerTexts()).map(s => s.trim());

    // Дата оновлення: "Дата оновлення інформації – 13:48 26.12.2025"
    const updMatch = text.match(/дата оновлення інформації\s*–\s*([0-9]{1,2}:[0-9]{2}\s+[0-9]{2}\.[0-9]{2}\.[0-9]{4})/i);
    const updatedAt = updMatch ? updMatch[1] : null;

    if (isOff) {
        return {
            status: "OFF",
            reason: strong[0] ?? null,
            start: strong[1] ?? null,
            restore: strong[2] ?? null,
            updatedAt,
            text: textRaw,
        };
    }

    // ON-шаблон (службове повідомлення)
    return {
        status: "ON",
        updatedAt,
        text: textRaw,
    };
}

async function readResolvedAddress(page) {
    const city = (await page.locator("#discon_form #city").first().inputValue().catch(() => "")).trim();
    const street = (await page.locator("#discon_form #street").first().inputValue().catch(() => "")).trim();
    const house = (await page.locator("#discon_form #house_num").first().inputValue().catch(() => "")).trim();

    const text = [city, street, house].filter(Boolean).join(", ");

    return {
        city: city || null,
        street: street || null,
        house: house || null,
        text: text || null
    };
}

async function readGroupName(page) {
    const el = page.locator("#group-name span");
    if (await el.count()) {
        const t = (await el.first().innerText()).trim();
        return t || null;
    }
    return null;
}

async function readScheduleUpdatedAt(page) {
    const ui = page.locator(".discon-fact-info .update");
    if (await ui.count()) return (await ui.first().innerText()).trim();

    const hidden = page.locator("form#discon_form input[name='updateFact']");
    if (await hidden.count()) return (await hidden.first().getAttribute("value"))?.trim() ?? null;

    return null;
}

// ======================
// 3️⃣ Telegram formatting helpers
// ======================
function fmtDateTime(isoOrNull) {
    if (!isoOrNull) return null;
    const d = new Date(isoOrNull);
    if (Number.isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(
        d.getHours()
    )}:${pad(d.getMinutes())}`;
}

function msToHuman(ms) {
    if (!ms || ms < 0) return null;
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h <= 0) return `${m} хв`;
    if (m <= 0) return `${h} год`;
    return `${h} год ${m} хв`;
}

function buildFrontendLink({ city, street, house }) {
    if (!FRONTEND_URL) return null;
    const u = new URL(FRONTEND_URL);
    u.searchParams.set("city", city);
    u.searchParams.set("street", street);
    u.searchParams.set("house", house);
    return u.toString();
}

function formatStatusMessage({ data, user }) {
    const status = data?.current?.status ?? "UNKNOWN";
    const head =
        status === "OFF"
            ? "❌ Немає світла"
            : status === "ON"
                ? "✅ Світло є"
                : "❔ Статус невідомий";

    const changedAt = fmtDateTime(user?.lastStatusChangedAt);

    const sinceIso = status === "ON" ? user?.lastOnAt : user?.lastOffAt;
    const sinceHuman = sinceIso
        ? msToHuman(Date.now() - new Date(sinceIso).getTime())
        : null;

    const addr =
        data?.resolvedAddress?.text ||
        [user?.city, user?.street, user?.house].filter(Boolean).join(", ");
    const group = data?.groupName ?? user?.groupName ?? null;
    const link =
        user?.city && user?.street && user?.house
            ? buildFrontendLink({ city: user.city, street: user.street, house: user.house })
            : null;

    const lines = [
        head,
        addr ? `📍 ${addr}` : null,
        group ? `Черга: ${group}` : null,
        changedAt ? `Остання зміна: ${changedAt}` : null,
        sinceHuman ? `Триває: ${sinceHuman}` : null,
        data?.current?.reason ? `Причина: ${data.current.reason}` : null,
        data?.current?.restore ? `Відновлення: ${data.current.restore}` : null,
        data?.current?.updatedAt ? `Оновлено: ${data.current.updatedAt}` : null,
        link ? `Детальніше: ${link}` : null,
    ].filter(Boolean);

    return lines.join("\n");
}

// ======================
// 2️⃣ PLAYWRIGHT: one function for API + cron
// ======================
async function fetchStatusWithTables({ city, street, house }) {
    const c = String(city ?? "").trim();
    const s = String(street ?? "").trim();
    const h = String(house ?? "").trim();

    if (!DTEK_URL) throw new Error("DTEK_URL is not set");
    if (!c || !s || !h) throw new Error("Missing address: city, street, house");

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();

        await page.goto(DTEK_URL, { waitUntil: "domcontentloaded", timeout: 45000 });

        await closeModal(page);

        await fillAutocomplete(page, "#discon_form #city", c);
        await fillAutocomplete(page, "#discon_form #street", s);
        await fillAutocomplete(page, "#discon_form #house_num", h);

        const resolvedAddress = await readResolvedAddress(page);

        // Wait for results
        await page.locator("#showCurOutage").waitFor({ state: "visible", timeout: 20000 });

        const current = await readCurrentOutage(page);
        const groupName = await readGroupName(page);
        const scheduleUpdatedAt = await readScheduleUpdatedAt(page);

        // day графік (залишаємо як було)
        let day = { todayRel: null, tomorrowRel: null, today: null, tomorrow: null };
        try {
            const { todayRel, tomorrowRel } = await readTodayTomorrowRel(page);
            day.todayRel = todayRel || null;
            day.tomorrowRel = tomorrowRel || null;

            if (day.todayRel) day.today = await readDayScheduleByRel(page, day.todayRel);
            if (day.tomorrowRel) day.tomorrow = await readDayScheduleByRel(page, day.tomorrowRel);
        } catch {
            // ok
        }

        // 👉 БЕРЕМО HTML ТАБЛИЦЬ ЯК Є
        const base = new URL(DTEK_URL).origin;
        const fix = (html) =>
            html
                ?.replaceAll('src="/', `src="${base}/`)
                .replaceAll('href="/', `href="${base}/`);

        const factHtml = await page
            .locator("#discon-fact .discon-fact-table.active table")
            .evaluate((el) => el.outerHTML)
            .catch(() => null);

        const weekHtml = await page
            .locator(".discon-schedule-table #tableRenderElem table")
            .evaluate((el) => el.outerHTML)
            .catch(() => null);

        return {
            current,
            groupName,
            scheduleUpdatedAt,
            day,
            factHtml: fix(factHtml),
            weekHtml: fix(weekHtml),
            resolvedAddress,
        };
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

async function readDaySchedule(page, relUnix) {
    const table = page.locator(`#discon-fact .discon-fact-table[rel="${relUnix}"] table tbody tr`);
    await table.first().waitFor({ state: "attached", timeout: 20000 });

    // У рядку перші 2 td — службові, далі 24 години
    const tds = table.locator("td");
    const count = await tds.count();

    // очікуємо 26 td (2 + 24)
    if (count < 26) return null;

    const hours = [];
    for (let i = 2; i < 26; i++) {
        const cls = (await tds.nth(i).getAttribute("class")) || "";
        hours.push(cellClassToState(cls));
    }
    return hours; // масив 24 елементи
}

async function readDayScheduleByRel(page, rel) {
    // чекаємо саме таблицю (а не tr)
    const table = page.locator(`#discon-fact .discon-fact-table[rel="${rel}"] table`);
    await table.waitFor({ state: "visible", timeout: 20000 });

    // беремо всі td у першому рядку
    const tds = table.locator("tbody tr").first().locator("td");
    const count = await tds.count();

    // debug (тимчасово)
    // console.log("TD COUNT for rel", rel, "=", count);

    if (count < 26) return null;

    const hours = [];
    for (let i = 2; i < 26; i++) {
        const cls = (await tds.nth(i).getAttribute("class")) || "";
        hours.push(cellClassToState(cls));
    }
    return hours;
}

async function readWeekNote(page) {
    const alert = page.locator(".discon-schedule-table .discon-schedule-alert .discon-info-text");
    if (await alert.count()) return (await alert.first().innerText()).trim();
    return null;
}

async function readTodayTomorrowRel(page) {
    const active = page.locator("#discon-fact .dates .date.active").first();
    const todayRel = await active.getAttribute("rel");

    const tomorrow = page.locator("#discon-fact .dates .date").nth(1);
    const tomorrowRel = await tomorrow.getAttribute("rel");

    return {
        todayRel: todayRel || null,
        tomorrowRel: tomorrowRel || null,
    };
}

async function readWeekSchedule(page) {
    const table = page.locator(".discon-schedule-table #tableRenderElem table");
    if (!(await table.count())) return null;

    const rows = table.locator("tbody tr");
    const n = await rows.count();
    if (!n) return null;

    const week = [];
    for (let r = 0; r < n; r++) {
        const row = rows.nth(r);
        const dayName = (await row.locator("td").first().innerText()).trim();

        const tds = row.locator("td");
        const tdCount = await tds.count();
        // перші 2 td — “Понеділок” та службові, далі 24
        if (tdCount < 26) continue;

        const hours = [];
        for (let i = 2; i < 26; i++) {
            const cls = (await tds.nth(i).getAttribute("class")) || "";
            hours.push(cellClassToState(cls));
        }
        week.push({ dayName, hours });
    }
    return week;
}


app.get("/api/status", async (req, res) => {
    try {
        const city = String(req.query.city ?? CITY ?? "").trim();
        const street = String(req.query.street ?? STREET ?? "").trim();
        const house = String(req.query.house ?? HOUSE ?? "").trim();

        if (!city || !street || !house) {
            return res.status(400).json({
                error: "Передай city, street, house. Напр: /api/status?city=...&street=...&house=... (або задай CITY/STREET/HOUSE в .env)"
            });
        }

        const data = await fetchStatusWithTables({ city, street, house });
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: String(e?.stack || e) });
    }
});

// ======================
// 🔁 CRON health endpoint (step 1)
// ======================
app.post("/api/cron/ping", (req, res) => {
    const secret = req.header("x-cron-secret");
    if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    res.json({ ok: true, ts: new Date().toISOString() });
});

// ======================
// 🔁 CRON check endpoint (step 1: no Telegram notify yet)
// ======================
app.post("/api/cron/check", async (req, res) => {
    try {
        const secret = req.header("x-cron-secret");
        if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const chatIds = await redis.smembers(USERS_SET);

        let total = chatIds.length;
        let checked = 0;
        let updated = 0;
        let errors = 0;

        for (const chatId of chatIds) {
            const id = String(chatId);
            try {
                const u = await getUser(id);
                if (!u?.city || !u?.street || !u?.house) continue;

                const data = await fetchStatusWithTables({
                    city: u.city,
                    street: u.street,
                    house: u.house,
                });

                const newStatus = data?.current?.status ?? "UNKNOWN";
                const prevStatus = u?.lastStatus ?? null;

                checked++;

                const nowIso = new Date().toISOString();
                const changed = prevStatus !== newStatus;

                await saveUser(id, {
                    ...u,
                    groupName: data?.groupName ?? u?.groupName ?? null,
                    lastStatus: newStatus,
                    lastCheckedAt: nowIso,
                    ...(changed ? { lastStatusChangedAt: nowIso } : {}),
                    ...(changed && newStatus === "ON" ? { lastOnAt: nowIso } : {}),
                    ...(changed && newStatus === "OFF" ? { lastOffAt: nowIso } : {}),
                });

                if (changed) updated++;
            } catch (e) {
                errors++;
                console.error("cron/check user error", id, e);
            }
        }

        res.json({ ok: true, total, checked, updated, errors, ts: new Date().toISOString() });
    } catch (e) {
        res.status(500).json({ error: String(e?.stack || e) });
    }
});

// ======================
// 🤖 Telegram bot (webhook)
// ======================
if (bot) {
    // Step-by-step setup wizard
    const setupWizard = new Scenes.WizardScene(
        "setup-wizard",
        async (ctx) => {
            ctx.wizard.state.addr = {};
            await ctx.reply("Введіть населений пункт (місто/село) українською:");
            return ctx.wizard.next();
        },
        async (ctx) => {
            const city = String(ctx.message?.text ?? "").trim();
            if (city.length < 2) {
                await ctx.reply("Будь ласка, введіть населений пункт ще раз:");
                return;
            }
            ctx.wizard.state.addr.city = city;
            await ctx.reply("Введіть вулицю українською:");
            return ctx.wizard.next();
        },
        async (ctx) => {
            const street = String(ctx.message?.text ?? "").trim();
            if (street.length < 2) {
                await ctx.reply("Будь ласка, введіть вулицю ще раз:");
                return;
            }
            ctx.wizard.state.addr.street = street;
            await ctx.reply("Введіть номер будинку (наприклад: 12 або 12А або 2в):");
            return ctx.wizard.next();
        },
        async (ctx) => {
            const house = String(ctx.message?.text ?? "").trim();
            if (house.length < 1) {
                await ctx.reply("Будь ласка, введіть номер будинку ще раз:");
                return;
            }

            const { city, street } = ctx.wizard.state.addr;
            const id = String(ctx.chat.id);

            await saveUser(id, {
                city,
                street,
                house,
                groupName: null,
                lastStatus: null,
                lastStatusChangedAt: null,
                lastOnAt: null,
                lastOffAt: null,
                lastCheckedAt: null,
                createdAt: new Date().toISOString(),
            });

            await ctx.reply(`✅ Адресу збережено:\n${city}, ${street}, ${house}\n\nТепер /status`);
            return ctx.scene.leave();
        }
    );

    const stage = new Scenes.Stage([setupWizard]);
    bot.use(session());
    bot.use(stage.middleware());

    bot.start(async (ctx) => {
        await ctx.reply(
            "Привіт!\n\n" +
            "Налаштуй адресу командою /setup\n" +
            "Перевір статус: /status"
        );
    });

    bot.command("setup", async (ctx) => ctx.scene.enter("setup-wizard"));

    // Backward compatible: /set starts wizard too
    bot.command("set", async (ctx) => ctx.scene.enter("setup-wizard"));

    bot.command("status", async (ctx) => {
        const id = String(ctx.chat.id);
        const u = await getUser(id);
        if (!u?.city || !u?.street || !u?.house) {
            return ctx.reply("Спочатку налаштуй адресу: /setup");
        }

        try {
            const data = await fetchStatusWithTables({ city: u.city, street: u.street, house: u.house });

            const newStatus = data?.current?.status ?? "UNKNOWN";
            const prevStatus = u?.lastStatus ?? null;
            const nowIso = new Date().toISOString();
            const changed = prevStatus !== newStatus;

            const nextUser = {
                ...u,
                groupName: data?.groupName ?? u?.groupName ?? null,
                lastCheckedAt: nowIso,
                lastStatus: newStatus,
                ...(changed ? { lastStatusChangedAt: nowIso } : {}),
                ...(changed && newStatus === "ON" ? { lastOnAt: nowIso } : {}),
                ...(changed && newStatus === "OFF" ? { lastOffAt: nowIso } : {}),
            };

            await saveUser(id, nextUser);

            const msg = formatStatusMessage({ data, user: nextUser });
            await ctx.reply(msg);
        } catch (e) {
            console.error("/status error", e);
            await ctx.reply("Не вдалось отримати статус з сайту ДТЕК. Спробуй ще раз через 1-2 хв.");
        }
    });
}

// webhook receiver
app.post("/api/tg/webhook", async (req, res) => {
    try {
        if (!bot) return res.sendStatus(503);
        await bot.handleUpdate(req.body);
    } catch (e) {
        console.error("TG webhook error:", e);
    }
    res.sendStatus(200);
});

app.listen(PORT, async () => {
    console.log(`API running: http://localhost:${PORT}`);

    try {
        if (bot && PUBLIC_BASE_URL) {
            const url = `${PUBLIC_BASE_URL}/api/tg/webhook`;
            await bot.telegram.setWebhook(url);
            console.log("✅ Webhook set:", url);
        } else if (!BOT_TOKEN) {
            console.log("⚠️ BOT_TOKEN is not set — bot disabled");
        } else if (!PUBLIC_BASE_URL) {
            console.log("⚠️ PUBLIC_BASE_URL is not set — cannot set webhook");
        }
    } catch (e) {
        console.error("❌ Failed to set webhook", e);
    }
});

process.once("SIGINT", () => bot?.stop("SIGINT"));
process.once("SIGTERM", () => bot?.stop("SIGTERM"));
