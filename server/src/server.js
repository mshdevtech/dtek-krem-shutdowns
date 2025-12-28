import "dotenv/config";
import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT ?? 3001);
const DTEK_URL = process.env.DTEK_URL;
const CITY = process.env.CITY;
const STREET = process.env.STREET;
const HOUSE = process.env.HOUSE;

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
        await page.waitForTimeout(200);
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


async function fillAutocomplete(page, inputSelector, value, { delayMs = 400 } = {}) {
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

    // чекати, поки зʼявиться список
    await page.waitForTimeout(delayMs);

    const firstItem = page.locator(firstItemSelector).first();
    await firstItem.waitFor({ state: "visible", timeout: 10000 });

    // клік по першій опції (вона вставляє значення в інпут)
    await firstItem.click();
    await page.waitForTimeout(150);

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
    let browser;
    try {
        const city = String(req.query.city ?? process.env.CITY ?? "").trim();
        const street = String(req.query.street ?? process.env.STREET ?? "").trim();
        const house = String(req.query.house ?? process.env.HOUSE ?? "").trim();

        if (!DTEK_URL) return res.status(500).json({ error: "DTEK_URL is not set" });

        if (!city || !street || !house) {
            return res.status(400).json({
                error: "Передай city, street, house. Напр: /api/status?city=...&street=...&house=..."
            });
        }

        browser = await chromium.launch({ headless: true });

        const page = await browser.newPage();
        await page.goto(DTEK_URL, { waitUntil: "domcontentloaded", timeout: 45000 });

        await page.waitForTimeout(300);

        await closeModal(page);

        await fillAutocomplete(page, "#discon_form #city", city);
        await fillAutocomplete(page, "#discon_form #street", street);
        await fillAutocomplete(page, "#discon_form #house_num", house);

        const resolvedAddress = await readResolvedAddress(page);

        // Wait for results
        await page.locator("#showCurOutage").waitFor({ state: "visible", timeout: 20000 });
        await page.waitForTimeout(700);

        const current = await readCurrentOutage(page);
        const groupName = await readGroupName(page);
        const scheduleUpdatedAt = await readScheduleUpdatedAt(page);

        // day графік
        let day = { todayRel: null, tomorrowRel: null, today: null, tomorrow: null };
        try {
            // якщо блок активний — супер, але не прив’язуємось жорстко
            const { todayRel, tomorrowRel } = await readTodayTomorrowRel(page);
            day.todayRel = todayRel || null;
            day.tomorrowRel = tomorrowRel || null;

            if (day.todayRel) day.today = await readDayScheduleByRel(page, day.todayRel);
            if (day.tomorrowRel) day.tomorrow = await readDayScheduleByRel(page, day.tomorrowRel);
        } catch {
            // залишиться null — ок
        }

        // week графік або note
        // 👉 БЕРЕМО HTML ТАБЛИЦЬ ЯК Є
        const base = new URL(DTEK_URL).origin;
        const fix = (html) =>
            html
                ?.replaceAll('src="/', `src="${base}/`)
                .replaceAll('href="/', `href="${base}/`);

        const factHtml = await page
            .locator("#discon-fact .discon-fact-table.active table")
            .evaluate(el => el.outerHTML)
            .catch(() => null);

        const weekHtml = await page
            .locator(".discon-schedule-table table")
            .evaluate(el => el.outerHTML)
            .catch(() => null);

        res.json({
            current,
            groupName,
            scheduleUpdatedAt,
            day,
            factHtml: fix(factHtml),
            weekHtml: fix(weekHtml),
            resolvedAddress,
        });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => {
    console.log(`API running: http://localhost:${PORT}`);
});
