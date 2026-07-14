# DAC Group — Automated Form Testing (Playwright)

Automated submission testing for **every form on www.dacgroup.com, across all
locales**. For each locale × page, the suite auto-discovers forms, smart-fills every
input, and runs two passes per form:

1. **Invalid pass** — clears required fields + injects a malformed email, submits,
   and asserts the form is *rejected* (validation errors, or no success/navigation).
2. **Valid pass** — fills plausible, locale-appropriate data, asserts no client-side
   validation fires, and confirms the submission is *accepted*.

## ⚠️ Production safety — dry-run by default

`www.dacgroup.com` is production. A real valid submission delivers a lead to DAC's
CRM and emails their sales team. So the **valid pass runs in dry-run mode by
default**: the final submission request is intercepted and answered with a synthetic
`200`. This proves the form passed validation and *would* submit — **without
delivering a real lead.**

```bash
npm test                 # dry-run: no real leads delivered  (SAFE, default)
SUBMIT_FOR_REAL=1 npm test   # actually submits — use against STAGING only
```

## Setup

```bash
npm install
sudo npx playwright install-deps chromium   # one-time OS libraries (needs sudo)
npx playwright install chromium             # already done if browser present
```

## Running

```bash
npm test                     # full matrix, all locales × pages, dry-run
npm run test:headed          # watch it in a real browser window
npm run report               # open the HTML report after a run

# Point at staging instead of production:
BASE_URL=https://staging.dacgroup.com npm test

# Narrow the run while iterating:
ONLY_LOCALE=en-GB ONLY_PAGE=/contact/ npm test
WORKERS=1 npm test           # single-threaded (gentlest on the server)
```

## Locales covered

| Prefix     | Region          |
|------------|-----------------|
| `` (root)  | US (default)    |
| `/en-ca`   | Canada (EN)     |
| `/fr-ca`   | Canada (FR)     |
| `/en-gb`   | United Kingdom  |
| `/de`      | Germany         |
| `/fr`      | France          |
| `/es`      | Spain           |

Edit `config.ts` to add/remove locales, add form-bearing pages, or toggle behavior.

## How it works

- **`config.ts`** — locales, pages to crawl, dry-run toggle, run filters.
- **`src/fill.ts`** — field discovery, valid/invalid value generation (type- and
  label-driven, localized sample data), submission interception, and success/error
  detection heuristics.
- **`tests/forms.spec.ts`** — data-driven matrix; soft assertions so one broken form
  doesn't hide results for others; auto-skips locale/page combos that 404 or have no
  meaningful forms.

## Tuning notes

- **Field heuristics** live in `validValue()` in `src/fill.ts`. If a field is filled
  with the wrong kind of data, add a keyword branch there.
- **Success detection** (`looksSuccessful`) and **error detection**
  (`hasValidationErrors`) use common WordPress/CF7/HubSpot markers. If DAC uses a
  custom confirmation UI, add its selector/text there for tighter assertions.
- Failures capture **trace, screenshot, and video** automatically
  (`playwright-report/` + `test-results/`).

---

# Hourly monitoring: WordPress ⇄ GitHub Actions

The suite runs **hourly** on GitHub Actions and reports results **into WordPress**.
WordPress owns the schedule (WP-Cron) and displays results; GitHub Actions runs the
browser (the WP host can't run headless Chromium).

```
WP-Cron (hourly) ──repository_dispatch──▶ GitHub Actions ──▶ Playwright (dry-run)
        ▲                                        │                    │
        │  dead-man's switch                     │  upload HTML report │ summary.json
        │  (alerts if no run in ~90m)            ▼                     ▼
   WP REST /dac-monitor/v1/runs ◀── POST (bearer + HMAC + timestamp) ── report-to-wp.mjs
        │  store as CPT (idempotent by run id)
        ├─▶ admin dashboard page + widget
        └─▶ email on pass→fail / fail→pass transitions
```

GitHub Actions also carries an **independent `schedule:` trigger** (`35 * * * *`) so
monitoring keeps working even if the WP site — and therefore WP-Cron — is down.

## Pieces

| Location | What it does |
|----------|--------------|
| `.github/workflows/form-tests.yml` | Triggers (dispatch / manual / schedule), runs tests, uploads report, POSTs results. |
| `src/reporters/summary-reporter.ts` | Emits `summary.json` (per locale×page pass/fail + annotations). CI only. |
| `scripts/report-to-wp.mjs` | Signs `summary.json` (HMAC+timestamp) and POSTs to the WP ingest endpoint. |
| `wordpress/dac-form-monitor/` | WordPress plugin: dispatch, REST ingest, runs CPT, admin dashboard, emails, dead-man's switch. |

## Setup

### 1. GitHub repo secrets (Settings → Secrets → Actions)
| Secret | Value |
|--------|-------|
| `WP_INGEST_URL` | `https://www.dacgroup.com/wp-json/dac-monitor/v1/runs` |
| `WP_INGEST_TOKEN` | shared bearer (any long random string) |
| `WP_INGEST_HMAC_SECRET` | shared HMAC secret (any long random string) |
| `BASE_URL` *(optional)* | staging origin override |

The workflow must live on the repo's **default branch** for `repository_dispatch` to fire.

### 2. WordPress
Copy `wordpress/dac-form-monitor/` into `wp-content/plugins/`, activate it, then define
these in **`wp-config.php`** (not the database — keeps secrets out of DB dumps):

```php
define('DAC_GH_DISPATCH_TOKEN', 'github_pat_...');   // fine-grained PAT, single repo, Contents: Read/write
define('DAC_GH_REPO', 'your-org/automated-testing'); // repo hosting this suite
define('DAC_FORM_INGEST_TOKEN', '...');              // must equal WP_INGEST_TOKEN
define('DAC_FORM_INGEST_HMAC_SECRET', '...');        // must equal WP_INGEST_HMAC_SECRET
// Optional:
define('DAC_FORM_BASE_URL', 'https://staging.dacgroup.com'); // dispatch target override
define('DAC_FORM_ALERT_EMAIL', 'qa@dacgroup.com');           // defaults to admin_email
```

On activation the plugin schedules: hourly **dispatch**, a 30-min **dead-man's switch**,
and a daily **prune** (deletes runs older than 30 days). Admin UI lives at
**WP Admin → Form Monitor** (list + "Run form tests now" button) plus a dashboard widget.

### 3. Make WP-Cron reliable (managed host)
WP-Cron only fires on site traffic. For dependable hourly runs, in `wp-config.php`:

```php
define('DISABLE_WP_CRON', true);
```

…then add a **real** hourly trigger via your host's cron panel or an external ping:

```
curl -s https://www.dacgroup.com/wp-cron.php?doing_wp_cron >/dev/null   # hourly
# or, with WP-CLI/SSH:
wp cron event run --due-now
```

The GitHub `schedule:` trigger is the backstop. Because the valid pass is **dry-run**, an
occasional double run delivers **zero real leads** — the ingest upserts by run id.

## Security model
- **GitHub PAT** stored in `wp-config.php`, single-repo, minimal scope (`Contents: Read/write`).
  (Fine-grained PATs expire ≤1 yr — the dead-man's switch catches the silent stop; consider a GitHub App later.)
- **Inbound results** authenticated by bearer + **HMAC-SHA256** over `"<ts>.<body>"` +
  **±5-min timestamp** skew, all constant-time (`hash_equals`). Prevents a forged "all-green"
  run from suppressing outage alerts.
- Only **pass/fail metadata** is stored — never submitted field values.

## ⚠️ Before enabling hourly go-live
**Bot defenses.** If DAC's forms use reCAPTCHA / hCaptcha / Turnstile / a WAF rate-limiter,
hourly hits from GitHub IPs may be silently rejected (score-based) or hard-blocked — poisoning
every result with false failures. **Run the workflow manually once** (`workflow_dispatch`) and
check the report before trusting the schedule. If defenses are present, point monitoring at a
captcha-free **staging** origin (`BASE_URL`) or have DAC allowlist the QA user-agent/secret header.

## Verifying the pipeline
1. **Ingest auth** — `curl -X POST` the REST route with a valid bearer+HMAC+fresh timestamp
   (201 + a CPT row), then a bad token (403) and a stale timestamp (401).
2. **WP-Cron** — `wp cron event list` shows `dac_dispatch_form_tests`; `wp cron event run
   dac_dispatch_form_tests` fires a GitHub run.
3. **Workflow** — trigger `workflow_dispatch` from the Actions UI; watch `summary.json`,
   the artifact upload, and the POST step.
4. **End-to-end** — dispatch → run → a row appears under **Form Monitor** + the widget updates.
5. **Alerts** — force a red run (bad `base_url`); confirm one email on pass→fail, none on the
   next identical failing run, and a recovery email on green.
