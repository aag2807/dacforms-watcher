/**
 * Test surface configuration.
 *
 * `locales` are the URL path prefixes DAC uses for each region.
 * `pages` are locale-relative paths that contain forms we want to exercise.
 *
 * The suite visits BASE_URL + locale + page for every combination, auto-discovers
 * every <form> on the page, and runs a valid + invalid submission against each.
 */

export interface Locale {
  /** Path prefix, '' for the default US site. */
  prefix: string;
  /** Human label used in test titles + reports. */
  label: string;
  /** BCP-47-ish tag, used to pick locale-appropriate sample data. */
  lang: string;
}

export const locales: Locale[] = [
  { prefix: '',        label: 'US (default)',  lang: 'en-US' },
  { prefix: '/en-ca',  label: 'Canada (EN)',   lang: 'en-CA' },
  { prefix: '/fr-ca',  label: 'Canada (FR)',   lang: 'fr-CA' },
  { prefix: '/en-gb',  label: 'United Kingdom', lang: 'en-GB' },
  { prefix: '/de',     label: 'Germany',       lang: 'de-DE' },
  { prefix: '/fr',     label: 'France',        lang: 'fr-FR' },
  { prefix: '/es',     label: 'Spain',         lang: 'es-ES' },
];

/**
 * Locale-relative paths to crawl for forms. Trailing slash matches DAC's routing.
 * Add paths here as you find more forms (demo requests, resource downloads, etc.).
 */
export const pages: string[] = [
  '/contact/',
  '/careers/',
  '/', // footer newsletter signup lives on every page; homepage is enough
];

/**
 * When true (default), the valid-data pass intercepts the final submission request
 * and returns a synthetic 200 — it proves the form passed client-side validation and
 * fired its request WITHOUT delivering a real lead to DAC's CRM.
 *
 * Set SUBMIT_FOR_REAL=1 to actually deliver submissions (use against staging only).
 */
export const DRY_RUN = process.env.SUBMIT_FOR_REAL !== '1';

/**
 * Optionally restrict a run to one locale/page for quick iteration:
 *   ONLY_LOCALE=en-GB ONLY_PAGE=/contact/ npm test
 */
export const ONLY_LOCALE = process.env.ONLY_LOCALE || '';
export const ONLY_PAGE = process.env.ONLY_PAGE || '';
