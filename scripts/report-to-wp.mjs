#!/usr/bin/env node
/**
 * Posts the Playwright run summary to the WordPress ingest endpoint.
 *
 * Reads summary.json (produced by src/reporters/summary-reporter.ts in CI), signs it,
 * and POSTs to WP_INGEST_URL. Auth is layered:
 *   - Authorization: Bearer <WP_INGEST_TOKEN>        (possession)
 *   - X-DAC-Timestamp: <unix seconds>                (anti-replay)
 *   - X-DAC-Signature: sha256=<hex>                  (HMAC over `${ts}.${body}`, integrity)
 *
 * The WP side recomputes the HMAC over the RAW body it receives, so we send exactly the
 * bytes we signed. Node 24 built-ins only — no dependencies.
 *
 * Exit codes: 0 on success OR when ingest is not configured (so the workflow's own test
 * result, not the reporting step, determines the job's red/green). Non-zero only on a
 * genuine delivery failure to a configured endpoint.
 */
import { readFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';

const SUMMARY_FILE = process.env.SUMMARY_OUTFILE || 'summary.json';
const url = process.env.WP_INGEST_URL;
const token = process.env.WP_INGEST_TOKEN;
const hmacSecret = process.env.WP_INGEST_HMAC_SECRET;

function fail(msg, code = 1) {
  console.error(`[report-to-wp] ${msg}`);
  process.exit(code);
}

if (!url || !token || !hmacSecret) {
  // Not configured — don't break the workflow, just note it.
  console.log(
    '[report-to-wp] WP_INGEST_URL / WP_INGEST_TOKEN / WP_INGEST_HMAC_SECRET not all set — skipping ingest.',
  );
  process.exit(0);
}

let summary;
try {
  summary = JSON.parse(readFileSync(SUMMARY_FILE, 'utf8'));
} catch (e) {
  // No summary means the test job likely crashed before reporting; send a minimal
  // "errored" beacon so the dead-man's switch in WP stays fed and the failure is visible.
  console.warn(`[report-to-wp] could not read ${SUMMARY_FILE} (${e.message}); sending errored beacon.`);
  summary = {
    schema: 1,
    status: 'failed',
    startedAt: null,
    durationMs: 0,
    totals: { tests: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 },
    run: {
      runId: process.env.GITHUB_RUN_ID ?? null,
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      sha: process.env.GITHUB_SHA ?? null,
      ref: process.env.GITHUB_REF_NAME ?? null,
      runUrl:
        process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
          ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : null,
    },
    tests: [],
    note: 'summary.json missing — reporter did not run',
  };
}

// Serialize exactly once; sign and send the SAME bytes.
const body = JSON.stringify(summary);
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature =
  'sha256=' + createHmac('sha256', hmacSecret).update(`${timestamp}.${body}`).digest('hex');

// Local sanity check that our own signing is self-consistent (cheap guard against typos).
const recomputed =
  'sha256=' + createHmac('sha256', hmacSecret).update(`${timestamp}.${body}`).digest('hex');
if (
  signature.length !== recomputed.length ||
  !timingSafeEqual(Buffer.from(signature), Buffer.from(recomputed))
) {
  fail('internal signature mismatch — aborting');
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 20_000);

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-DAC-Timestamp': timestamp,
      'X-DAC-Signature': signature,
      'User-Agent': 'DAC-QA-Playwright-Reporter',
    },
    body,
    signal: controller.signal,
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    fail(`ingest returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  console.log(
    `[report-to-wp] delivered summary (${summary.status}, ` +
      `${summary.totals.failed} failed / ${summary.totals.tests} tests) → HTTP ${res.status}`,
  );
} catch (e) {
  fail(`delivery failed: ${e.message}`);
} finally {
  clearTimeout(timer);
}
