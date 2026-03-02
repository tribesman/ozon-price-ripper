const { loadPage } = require("./getPage");

/**
 * Переход на страницу товара и извлечение артикула (блок "Артикул" в характеристиках).
 * Разметка: <dl class="pdp_ia8"><dt>Артикул</dt><dd><span class="pdp_ia9">3564754829</span></dd></dl>
 *
 * @param {import('playwright').Page} page
 * @param {string} productUrl — полная ссылка на страницу товара
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<string | null>} артикул или null
 */
async function getArticle(page, productUrl, options = {}) {
  const timeout = options.timeout ?? 15000;
  try {
    await loadPage(page, productUrl, {
      waitUntil: "domcontentloaded",
      timeout,
      label: "product",
    });
    await page.waitForTimeout(800);

    const scrollCount = 1 + Math.floor(Math.random() * 4);
    for (let i = 0; i < scrollCount; i++) {
      const stepPx = 100 + Math.floor(Math.random() * 201);
      await page.evaluate((step) => window.scrollBy(0, step), stepPx);
      await page.waitForTimeout(100 + Math.floor(Math.random() * 301));
    }

    const article = await page.evaluate(() => {
      const dls = document.querySelectorAll("dl.pdp_ia8");
      for (const dl of dls) {
        const dt = dl.querySelector("dt");
        if (!dt || !dt.textContent.trim().includes("Артикул")) continue;
        const valueEl = dl.querySelector("dd span.pdp_ia9");
        if (valueEl) return valueEl.textContent.trim();
      }
      return null;
    });

    return article;
  } catch {
    return null;
  }
}

module.exports = { getArticle };
