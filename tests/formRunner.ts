import { test, expect, Locator, Page, TestInfo } from '@playwright/test';
import type { Locale } from '../config';
import { DRY_RUN } from '../config';
import {
  Field,
  discoverFields,
  fillValid,
  fillInvalid,
  submitAndObserve,
  hasValidationErrors,
  looksSuccessful,
  submitButton,
  clickSubmit,
} from '../src/fill';

/**
 * Forms with fewer than this many *visible* controls are treated as search boxes,
 * language pickers, etc. — not the lead/contact forms we care about.
 */
export const MIN_MEANINGFUL_FIELDS = 2;

/** A discovered lead/contact form plus its fields, in stable page order. */
export interface MeaningfulForm {
  form: Locator;
  fields: Field[];
}

/**
 * Wait for the page's forms to be ready. DAC's lead forms are HubSpot inline embeds
 * injected by JS after load, so a flat sleep either wastes time or races. Wait for the
 * embed if one is coming, then let fields settle.
 */
async function waitForForms(page: Page): Promise<void> {
  await page
    .locator('form[id^="hsForm_"]')
    .first()
    .waitFor({ state: 'attached', timeout: 4000 })
    .catch(() => {});
  await page.waitForTimeout(700);
}

/**
 * Collect the meaningful forms on the page in stable DOM order, each with its fields.
 * Applying the SAME filter here and after every reload is what keeps a form's index
 * stable — search boxes and hidden menu forms are dropped, not counted.
 */
async function collectMeaningfulForms(page: Page): Promise<MeaningfulForm[]> {
  const out: MeaningfulForm[] = [];
  for (const form of await page.locator('form').all()) {
    if (!(await form.isVisible().catch(() => false))) continue;
    const fields = await discoverFields(form);
    const visibleCount = fields.filter(
      (f) => !['hidden', 'submit', 'button', 'reset'].includes(f.type),
    ).length;
    if (visibleCount < MIN_MEANINGFUL_FIELDS) continue;
    // Skip phantom/duplicate forms whose submit control is collapsed (0×0) — a real user
    // can't submit them, and some pages carry a hidden copy of a newsletter form.
    if (!(await submitButton(form).isVisible().catch(() => false))) continue;
    out.push({ form, fields });
  }
  return out;
}

const CONSENT_HOSTS = '#usercentrics-cmp-ui, #usercentrics-root, #onetrust-banner-sdk';
/** Tests get a fresh context each, so handling these once sets a cookie that suppresses
 *  the overlay on every later reload in the same test — no need to wait again. */
const consentHandled = new WeakSet<Page>();
const langBannerChecked = new WeakSet<Page>();

/** Dismiss the overlays that intercept pointer events and silently block submit clicks:
 *  the cookie-consent banner and DAC's geo "visit our US site?" language banner. */
async function dismissOverlays(page: Page) {
  await dismissCookieConsent(page);
  await dismissLanguageBanner(page);
}

/**
 * DAC uses Usercentrics (`#usercentrics-cmp-ui`), whose banner mounts *asynchronously* a
 * few seconds after load and then overlays the whole page — a check right after
 * navigation runs too early. Wait for the accept button, click it, confirm it clears.
 */
async function dismissCookieConsent(page: Page) {
  if (consentHandled.has(page)) return;

  const accept = page
    .locator('[data-testid="uc-accept-all-button"], #onetrust-accept-btn-handler')
    .or(
      // Button labels vary by locale AND word order: en "Accept All", fr "Accepter tout",
      // de "Alles akzeptieren", es "Aceptar todo". Match the real Usercentrics labels.
      page.getByRole('button', {
        name: /accept all|accepter tout|tout accepter|alles? akzeptieren|aceptar todo|i agree/i,
      }),
    )
    .first();

  const appeared = await accept
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return; // no banner on this load; leave unhandled so a reload can retry

  await accept.click().catch(() => {});
  await page
    .locator(CONSENT_HOSTS)
    .first()
    .waitFor({ state: 'hidden', timeout: 5000 })
    .catch(() => {});
  consentHandled.add(page);
}

/**
 * On non-US locales DAC shows a geo banner ("you're outside the US — visit our US site?")
 * whose `.dynamic-banner-backdrop` overlays the page and blocks submit clicks. Closing it
 * (the X, NOT "Yes" which would navigate away) sets a cookie so it never returns, and geo
 * is stable per context — so one check per test is enough. Runs after consent, by which
 * point the async banner has mounted, so a single check reliably catches or clears it.
 */
async function dismissLanguageBanner(page: Page) {
  if (langBannerChecked.has(page)) return;
  const close = page.locator('.close-language-banner-button').first();
  const appeared = await close
    .waitFor({ state: 'visible', timeout: 6000 })
    .then(() => true)
    .catch(() => false);
  langBannerChecked.add(page); // geo is stable per context — checking once suffices
  if (!appeared) return;

  await close.click().catch(() => {});
  await page
    .locator('.dynamic-banner-backdrop')
    .first()
    .waitFor({ state: 'hidden', timeout: 3000 })
    .catch(() => {});
}

/**
 * Load a page, discover its meaningful forms, and run the valid + invalid cycle against
 * each. Skips (not fails) on 404 or when no meaningful form is present. `url` may be
 * relative (resolved against baseURL) or absolute — insight pages pass absolute URLs.
 */
export async function runFormChecks(
  page: Page,
  testInfo: TestInfo,
  loc: Locale,
  url: string,
): Promise<void> {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Some locale/page combos legitimately 404 — record and skip, don't hard-fail.
  if (resp && resp.status() >= 400) {
    testInfo.skip(true, `${url} returned HTTP ${resp.status()}`);
    return;
  }

  await dismissOverlays(page);
  await waitForForms(page);

  const targets = await collectMeaningfulForms(page);
  testInfo.annotations.push({
    type: 'discovery',
    description: `${targets.length} meaningful form(s) found at ${url} (dry-run=${DRY_RUN})`,
  });

  if (targets.length === 0) {
    testInfo.skip(true, `No meaningful forms found at ${url}`);
    return;
  }

  for (let i = 0; i < targets.length; i++) {
    await exerciseForm(page, i, loc, url, testInfo);
  }
}

/**
 * Run the full valid + invalid cycle against one form. Uses soft assertions so one
 * broken form doesn't mask results for the others on the same page.
 */
async function exerciseForm(
  page: Page,
  index: number,
  loc: Locale,
  url: string,
  testInfo: TestInfo,
) {
  await test.step(`Form #${index + 1} — invalid submission is rejected`, async () => {
    // Reload for a clean form state, then re-resolve the SAME meaningful form by
    // index. Re-filtering (not a raw form-list index) skips search/menu forms that
    // precede the real forms in the DOM.
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await dismissOverlays(page);
    await waitForForms(page);
    const target = (await collectMeaningfulForms(page))[index];
    if (!target) {
      testInfo.annotations.push({
        type: 'note',
        description: `form#${index + 1} not found after reload — skipped`,
      });
      return;
    }
    const freshForm = target.form;

    const fields = target.fields;
    const hasRequired = fields.some((f) => f.required);
    await fillInvalid(fields);

    const before = page.url();
    await clickSubmit(freshForm);
    await page.waitForTimeout(1000);

    const errored = await hasValidationErrors(freshForm);
    const navigatedAway = page.url() !== before;
    const success = await looksSuccessful(page, freshForm);

    // A correct form with required fields should either show errors or, at minimum,
    // NOT report success / navigate to a thank-you after an empty+bad-email submit.
    if (hasRequired) {
      expect
        .soft(
          errored || (!navigatedAway && !success),
          `[${loc.label} ${url} form#${index + 1}] invalid submission was NOT rejected ` +
            `(errors=${errored}, navigated=${navigatedAway}, success=${success})`,
        )
        .toBeTruthy();
    } else {
      testInfo.annotations.push({
        type: 'note',
        description: `form#${index + 1} has no required fields — invalid-input check is advisory`,
      });
    }
  });

  await test.step(`Form #${index + 1} — valid submission is accepted`, async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await dismissOverlays(page);
    await waitForForms(page);
    const target = (await collectMeaningfulForms(page))[index];
    if (!target) {
      testInfo.annotations.push({
        type: 'note',
        description: `form#${index + 1} not found after reload — skipped`,
      });
      return;
    }
    const freshForm = target.form;

    const fields = target.fields;
    const filled = await fillValid(fields, loc);
    expect
      .soft(filled, `[${loc.label} ${url} form#${index + 1}] no fields could be filled`)
      .toBeGreaterThan(0);

    // Valid data should NOT trip client-side validation.
    const preErrors = await hasValidationErrors(freshForm);
    expect
      .soft(
        preErrors,
        `[${loc.label} ${url} form#${index + 1}] valid data still triggered validation errors`,
      )
      .toBeFalsy();

    const { requestFired, navigated } = await submitAndObserve(page, freshForm, {
      dryRun: DRY_RUN,
    });
    const success = await looksSuccessful(page, freshForm);

    // Acceptance = the browser attempted a submission, OR the UI shows success/navigated.
    expect
      .soft(
        requestFired || navigated || success,
        `[${loc.label} ${url} form#${index + 1}] valid submission did not fire a request, ` +
          `navigate, or show success (dry-run=${DRY_RUN})`,
      )
      .toBeTruthy();

    testInfo.annotations.push({
      type: 'result',
      description: `form#${index + 1}: filled=${filled}, requestFired=${requestFired}, navigated=${navigated}, success=${success}`,
    });
  });
}
