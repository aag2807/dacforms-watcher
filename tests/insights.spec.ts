import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { locales, ONLY_LOCALE, ONLY_PAGE } from '../config';
import { runFormChecks } from './formRunner';

/**
 * Insight/content-type coverage: one live URL per language for each section (blog,
 * whitepapers, podcasts, webinars, work, localnews), read from the manifest that
 * scripts/build-insight-manifest.mjs builds from the site's sitemaps. Because WPML
 * translates slugs AND path segments, these URLs can't be derived from a locale prefix
 * — the manifest is the source of truth. Build it before running (npm test does this
 * via pretest; CI has a dedicated step).
 */
const MANIFEST = process.env.INSIGHT_MANIFEST || 'insight-urls.json';

interface Manifest {
  sections: Record<string, Record<string, string>>;
}

let manifest: Manifest | null = null;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
} catch {
  manifest = null;
}

const byLang = new Map(locales.map((l) => [l.lang, l]));

if (!manifest) {
  test.describe('Insights', () => {
    // eslint-disable-next-line no-empty-function
    test.skip('insight manifest missing — run scripts/build-insight-manifest.mjs', () => {});
  });
} else {
  for (const [section, urls] of Object.entries(manifest.sections)) {
    if (ONLY_PAGE && ONLY_PAGE !== section) continue;

    for (const [lang, url] of Object.entries(urls)) {
      const loc = byLang.get(lang);
      if (!loc) continue;
      if (ONLY_LOCALE && !lang.toLowerCase().includes(ONLY_LOCALE.toLowerCase())) continue;

      test.describe(`${loc.label} — ${section}`, () => {
        test('forms accept valid input and reject invalid input', async ({ page }, testInfo) => {
          await runFormChecks(page, testInfo, loc, url);
        });
      });
    }
  }
}
