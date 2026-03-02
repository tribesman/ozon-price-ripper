const fs = require("fs");
const path = require("path");

const PAGES_DIR = path.join(__dirname, "pages");
const SCRIPT_START_TS = Date.now();

if (!fs.existsSync(PAGES_DIR)) {
  fs.mkdirSync(PAGES_DIR, { recursive: true });
}

/**
 * Загрузка страницы с сохранением HTML в pages/page-XXXXX.html,
 * где XXXXX — миллисекунды с момента старта скрипта (с лидирующими нулями).
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {{ waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number; label?: string }} [options]
 * @returns {Promise<{ html: string; filePath: string }>}
 */
async function loadPage(page, url, options = {}) {
  const waitUntil = options.waitUntil ?? "domcontentloaded";
  const timeout = options.timeout ?? 30000;

  await page.goto(url, { waitUntil, timeout });

  const html = await page.content();
  const elapsed = Date.now() - SCRIPT_START_TS;
  const suffix = String(elapsed).padStart(5, "0");
  const fileName = `page-${suffix}.html`;
  const filePath = path.join(PAGES_DIR, fileName);

  fs.writeFileSync(filePath, html, "utf8");
  console.log(
    `HTML сохранён: ${filePath}${options.label ? ` (${options.label})` : ""}`,
  );

  return { html, filePath };
}

module.exports = { loadPage };

