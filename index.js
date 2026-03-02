require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { getArticle } = require("./getProductArticle");

const DEBUG_HTML_PATH = path.join(__dirname, "debug-page.html");
const AUTH_STATE_PATH = path.join(__dirname, ".playwright-ozon-state.json");

/** База (мс) + случайная добавка 10–1000 мс. */
function delayMs(baseMs) {
  return baseMs + Math.floor(Math.random() * 991) + 10;
}

(async () => {
  const sellerUrl = process.env.SELLER_URL;
  const baseTimeoutMs = Number(process.env.BASE_TIMEOUT_MS) || 3000;
  const headless = process.env.HEADLESS !== "false";

  // Chrome меньше палится антиботом, чем Chromium; иначе — Chromium с отключением флага автоматизации
  const launchOptions = {
    headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--window-position=0,0",
      "--ignore-certificate-errors",
    ],
  };
  let browser;
  try {
    browser = await chromium.launch({ ...launchOptions, channel: "chrome" });
  } catch {
    browser = await chromium.launch(launchOptions);
  }

  const contextOptions = {
    viewport: { width: 1380, height: 880 },
    deviceScaleFactor: 1,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    extraHTTPHeaders: {
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    },
    permissions: [],
    colorScheme: "light",
    javaScriptEnabled: true,
  };
  if (fs.existsSync(AUTH_STATE_PATH)) {
    contextOptions.storageState = AUTH_STATE_PATH;
    console.log("Загружено сохранённое состояние (cookies):", AUTH_STATE_PATH);
  }
  const context = await browser.newContext(contextOptions);

  const page = await context.newPage();

  // Маскировка автоматизации: webdriver, языки, платформа, chrome
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
      configurable: true,
    });
    Object.defineProperty(navigator, "languages", {
      get: () => ["ru-RU", "ru", "en-US", "en"],
      configurable: true,
    });
    Object.defineProperty(navigator, "platform", {
      get: () => "Win32",
      configurable: true,
    });
    if (!window.chrome) {
      window.chrome = {
        runtime: {},
        loadTimes: function () {},
        csi: function () {},
      };
    }
  });

  console.log(`Запуск...`);

  try {
    // domcontentloaded быстрее и не таймаутит на тяжёлых страницах; капча не успевает редиректить
    await page.goto(sellerUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(3000); // даём подгрузиться контенту

    // Сразу сохраняем HTML — даже если дальше упадёт, файл будет
    const html = await page.content();
    fs.writeFileSync(DEBUG_HTML_PATH, html, "utf8");
    console.log("HTML сохранён:", DEBUG_HTML_PATH);

    const isCaptchaPage =
      /Antibot Captcha|id="captcha-container"/i.test(html) ||
      (await page.title()).includes("Antibot");
    if (!isCaptchaPage) {
      await context.storageState({ path: AUTH_STATE_PATH });
      console.log(
        "Сохранено состояние после капчи (cookies, localStorage):",
        AUTH_STATE_PATH,
      );
    }

    let hasNextPage = true;
    const allProducts = [];
    const seenHrefs = new Set();

    await page.waitForLoadState("networkidle").catch(() => null);

    // Повторно сохраняем после прокрутки (актуальный список товаров)
    fs.writeFileSync(DEBUG_HTML_PATH, await page.content(), "utf8");
    console.log("HTML обновлён после прокрутки:", DEBUG_HTML_PATH);

    while (hasNextPage) {
      // Прокрутка до низа: шаг 100–300 px (рандом), пауза 100–1000 ms (рандом)
      let prevCount = 0;
      let stableRounds = 0;
      const maxScrolls = 200;
      for (let i = 0; i < maxScrolls; i++) {
        const stepPx = 0 + Math.floor(Math.random() * 201);
        await page.evaluate((step) => window.scrollBy(0, step), stepPx);
        const delay = 100 + Math.floor(Math.random() * 901);
        await page.waitForTimeout(delay);
        const pos = await page.evaluate(() => ({
          scrollY: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
          innerHeight: window.innerHeight,
        }));
        const atBottom = pos.scrollY + pos.innerHeight >= pos.scrollHeight - 2;
        const count = await page.evaluate(
          () =>
            document.querySelectorAll(
              'div.tile-root, [data-widget="tileGridDesktop"] div[data-index]',
            ).length,
        );
        if (count === prevCount) stableRounds += 1;
        else stableRounds = 0;
        prevCount = count;
        if (atBottom && stableRounds >= 2) break;
      }

      // Собираем товары: на странице продавца Ozon карточки — div.tile-root (data-widget="tileGridDesktop")
      // Товары после блока «Возможно, вам понравится» не учитываем
      const chunk = await page.evaluate(() => {
        const results = [];
        const cards = document.querySelectorAll(
          'div.tile-root, [data-widget="tileGridDesktop"] div[data-index]',
        );
        const seen = new Set();
        const stopLabel = "Возможно, вам понравится";
        const stopEl = Array.from(document.querySelectorAll("*")).find(
          (el) =>
            el.textContent.trim() === stopLabel ||
            el.textContent.trim().startsWith(stopLabel),
        );
        const DOCUMENT_POSITION_FOLLOWING = 4;

        for (const root of cards) {
          if (
            stopEl &&
            stopEl.compareDocumentPosition(root) & DOCUMENT_POSITION_FOLLOWING
          )
            continue;
          const link = root.querySelector('a[href*="/product/"]');
          const href = link
            ? (link.getAttribute("href") || "").split("?")[0]
            : "";
          if (!href || seen.has(href)) continue;
          seen.add(href);

          const titleEl =
            root.querySelector("span.tsBody500Medium") ||
            root.querySelector("span.tsBodyL") ||
            root.querySelector("span[class*='tsBody5']");
          const priceEl =
            root.querySelector("span.tsHeadline500Medium") ||
            root.querySelector("span[class*='tsHeadline'][class*='Medium']") ||
            Array.from(root.querySelectorAll("span")).find((el) => {
              const t = el.innerText || "";
              return /[\d\s\u00a0]+₽/.test(t) && t.length < 25;
            });

          const title = titleEl ? titleEl.innerText.trim() : "";
          const priceRaw = priceEl ? priceEl.innerText : "";
          const price = priceRaw.replace(/\D/g, "");

          if (title && price) results.push({ title, price, href });
        }
        return results;
      });

      const baseUrl = new URL(sellerUrl).origin;
      for (const { title, price, href } of chunk) {
        if (!seenHrefs.has(href)) {
          seenHrefs.add(href);
          const link = href.startsWith("http") ? href : baseUrl + href;
          allProducts.push({ title, price, link });
        }
      }

      const nextBtn = page.locator('a:has-text("Далее")').first();
      if (await nextBtn.isVisible()) {
        await nextBtn.click();
        await page.waitForTimeout(delayMs(baseTimeoutMs));
      } else {
        hasNextPage = false;
      }
    }

    console.log("Итого собрано товаров:", allProducts.length);

    for (let i = 0; i < allProducts.length; i++) {
      const product = allProducts[i];
      process.stdout.write(
        `Артикулы: ${i + 1}/${allProducts.length} — ${product.title.slice(0, 40)}…\r`,
      );
      product.article = await getArticle(page, product.link);
      await page.waitForTimeout(delayMs(300));
    }
    console.log("");

    console.table(allProducts);
    await context.storageState({ path: AUTH_STATE_PATH });
    console.log(
      "Сохранено состояние сессии для следующего запуска:",
      AUTH_STATE_PATH,
    );
  } catch (err) {
    console.error("Ошибка:", err.message);
    // При видимом браузере даём время посмотреть страницу и прочитать консоль
    if (!headless) {
      console.log("Пауза 15 сек перед закрытием (HEADLESS=false)...");
      await new Promise((r) => setTimeout(r, 15000));
    }
  } finally {
    await browser.close();
  }
})();
