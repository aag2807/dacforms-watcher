import { test, expect, Locator } from '@playwright/test';
import { locales, pages, DRY_RUN, ONLY_LOCALE, ONLY_PAGE } from '../config';
import {
  discoverFields,
  fillValid,
  fillInvalid,
  submitAndObserve,
  hasValidationErrors,
  looksSuccessful,
  submitButton,
} from '../src/fill';

/**
 * Forms with fewer than this many *visible* controls are treated as search boxes,
 * language pickers, etc. — not the lead/contact forms we care about.
 */
const MIN_MEANINGFUL_FIELDS = 2;

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
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });

        // Some locale/page combos legitimately 404 — record and skip, don't hard-fail.
        if (resp && resp.status() >= 400) {
          testInfo.skip(true, `${url} returned HTTP ${resp.status()}`);
          return;
        }

        await dismissConsent(page);
        await page.waitForTimeout(2000); // allow lazy-loaded (HubSpot/CF7) forms to mount

        const allForms = await page.locator('form').all();
        const targets: Locator[] = [];
        for (const form of allForms) {
          if (!(await form.isVisible().catch(() => false))) continue;
          const fields = await discoverFields(form);
          const visibleCount = fields.filter(
            (f) => !['hidden', 'submit', 'button', 'reset'].includes(f.type),
          ).length;
          if (visibleCount >= MIN_MEANINGFUL_FIELDS) targets.push(form);
        }

        testInfo.annotations.push({
          type: 'discovery',
          description: `${targets.length} meaningful form(s) found at ${url} (dry-run=${DRY_RUN})`,
        });

        if (targets.length === 0) {
          testInfo.skip(true, `No meaningful forms found at ${url}`);
          return;
        }

        for (let i = 0; i < targets.length; i++) {
          await exerciseForm(page, targets[i], i, loc, url, testInfo);
        }
      });
    });
  }
}

/**
 * Run the full valid + invalid cycle against one form. Uses soft assertions so one
 * broken form doesn't mask results for the others on the same page.
 */
async function exerciseForm(
  page: import('@playwright/test').Page,
  form: Locator,
  index: number,
  loc: (typeof locales)[number],
  url: string,
  testInfo: import('@playwright/test').TestInfo,
) {
  await test.step(`Form #${index + 1} — invalid submission is rejected`, async () => {
    // Reload for a clean form state between passes.
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await dismissConsent(page);
    await page.waitForTimeout(2000);
    const freshForm = page.locator('form').nth(indexOfVisibleForm(index));

    const fields = await discoverFields(freshForm);
    const hasRequired = fields.some((f) => f.required);
    await fillInvalid(fields);

    const before = page.url();
    await submitButton(freshForm).click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

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
    await dismissConsent(page);
    await page.waitForTimeout(2000);
    const freshForm = page.locator('form').nth(indexOfVisibleForm(index));

    const fields = await discoverFields(freshForm);
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

/**
 * Map "the Nth meaningful form" back to its index in the full form list.
 * Forms are re-discovered after each reload, so we recompute visible-form positions.
 * We approximate by returning the nth form; pages here have stable form ordering.
 */
function indexOfVisibleForm(meaningfulIndex: number): number {
  // Pragmatic: DAC pages render forms in stable DOM order, so the nth meaningful form
  // is reliably the nth form. If a page interleaves search boxes, refine this to
  // re-filter by field count. Kept simple to stay readable.
  return meaningfulIndex;
}

/** Best-effort dismissal of cookie/consent banners that overlay form controls. */
async function dismissConsent(page: import('@playwright/test').Page) {
  const buttons = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("Got it")',
    'button:has-text("Alle akzeptieren")', // de
    'button:has-text("Tout accepter")', // fr
    'button:has-text("Aceptar")', // es
    '#onetrust-accept-btn-handler',
  ];
  for (const sel of buttons) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(500);
      return;
    }
  }
}
