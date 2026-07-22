#!/usr/bin/env node
/**
 * Build the insight-page manifest the suite tests: one live URL per language for each
 * content section, discovered from the site's XML sitemaps. WPML translates both slugs
 * and path segments, so hardcoding URLs would rot — the sitemap is the source of truth.
 *
 * Output: JSON of shape { generatedAt, base, sections: { <section>: { <lang>: <url> } } }
 * written to $INSIGHT_MANIFEST (default ./insight-urls.json).
 *
 * Env: BASE_URL (default https://www.dacgroup.com), INSIGHT_MANIFEST.
 */
import { writeFileSync } from 'node:fs';

const BASE = (process.env.BASE_URL || 'https://www.dacgroup.com').replace(/\/$/, '');
const OUT = process.env.INSIGHT_MANIFEST || 'insight-urls.json';

// Section -> matcher for its sub-sitemap basename(s) in the sitemap index.
const SECTIONS = {
  blog: /^post-sitemap\d*\.xml$/,
  whitepapers: /^whitepapers-sitemap\.xml$/,
  podcasts: /^podcasts-sitemap\.xml$/,
  webinars: /^webinars-sitemap\.xml$/,
  work: /^work-sitemap\.xml$/,
  localnews: /^localnews-sitemap\.xml$/,
};

// URL locale prefix -> config lang tag. No prefix => default (US English).
const PREFIX_TO_LANG = {
  'en-ca': 'en-CA',
  'fr-ca': 'fr-CA',
  'en-gb': 'en-GB',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
};
const ALL_LANGS = new Set(['en-US', ...Object.values(PREFIX_TO_LANG)]);

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'DAC-QA-Playwright-Manifest' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Extract <loc> values (ignores <image:loc>, which is a different tag). */
function locs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

function langOf(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean)[0] || '';
    return PREFIX_TO_LANG[seg.toLowerCase()] || 'en-US';
  } catch {
    return 'en-US';
  }
}

// WPML lists sitemap URLs for items that aren't actually translated/published in that
// language, so the first URL per language can 404. Verify before selecting one.
const MAX_LIVENESS_CHECKS = 8; // per (section, language) — bounds requests

async function isLive(url) {
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'DAC-QA-Playwright-Manifest' },
      signal: AbortSignal.timeout(15_000),
    });
    // Some hosts reject HEAD — fall back to GET (headers only, body discarded).
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'DAC-QA-Playwright-Manifest' },
        signal: AbortSignal.timeout(20_000),
      });
      res.body?.cancel?.();
    }
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const index = await fetchText(`${BASE}/sitemap_index.xml`);
  const subSitemaps = locs(index);

  const sections = {};
  for (const [section, matcher] of Object.entries(SECTIONS)) {
    const files = subSitemaps.filter((u) => {
      const base = u.split('/').pop() || '';
      return matcher.test(base);
    });

    // Gather candidate URLs per language across the section's sub-sitemaps, capped so
    // large blog sitemaps don't accumulate thousands of entries.
    const candidates = {};
    const enough = () =>
      candidates && Object.keys(candidates).length >= ALL_LANGS.size &&
      Object.values(candidates).every((list) => list.length >= MAX_LIVENESS_CHECKS);
    for (const file of files) {
      if (enough()) break;
      let urls;
      try {
        urls = locs(await fetchText(file));
      } catch (err) {
        console.warn(`[manifest] skip ${file}: ${err.message}`);
        continue;
      }
      for (const url of urls) {
        const lang = langOf(url);
        const list = (candidates[lang] ||= []);
        if (list.length < MAX_LIVENESS_CHECKS) list.push(url);
      }
    }

    // Pick the first candidate that actually resolves (200) for each language.
    const perLang = {};
    for (const [lang, urls] of Object.entries(candidates)) {
      for (const url of urls) {
        if (await isLive(url)) {
          perLang[lang] = url;
          break;
        }
      }
    }
    sections[section] = perLang;
    const langs = Object.keys(perLang).sort();
    console.log(`[manifest] ${section}: ${langs.length} lang(s) — ${langs.join(', ') || 'none'}`);
  }

  const manifest = { generatedAt: new Date().toISOString(), base: BASE, sections };
  writeFileSync(OUT, JSON.stringify(manifest, null, 2));
  console.log(`[manifest] wrote ${OUT}`);
}

main().catch((err) => {
  console.error(`[manifest] failed: ${err.message}`);
  process.exit(1);
});
