import { test } from '@playwright/test';
import { locales, pages, ONLY_LOCALE, ONLY_PAGE } from '../config';
import { runFormChecks } from './formRunner';

/**
 * Static pages exercised for every locale: contact, careers, and the homepage
 * (footer newsletter). Insight/content-type pages are covered separately in
 * insights.spec.ts, driven by the sitemap-built manifest.
 */
const activeLocales = ONLY_LOCALE
  ? locales.filter((l) => l.lang.toLowerCase().includes(ONLY_LOCALE.toLowerCase()))
  : locales;
const activePages = ONLY_PAGE ? pages.filter((p) => p === ONLY_PAGE) : pages;

for (const loc of activeLocales) {
  for (const pagePath of activePages) {
    const url = `${loc.prefix}${pagePath}`.replace(/\/{2,}/g, '/');
    const suiteName = `${loc.label} — ${pagePath}`;

    test.describe(suiteName, () => {
      test(`forms accept valid input and reject invalid input`, async ({ page }, testInfo) => {
        await runFormChecks(page, testInfo, loc, url);
      });
    });
  }
}
