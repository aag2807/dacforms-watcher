import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  FullResult,
} from '@playwright/test/reporter';
import { writeFileSync } from 'node:fs';

/**
 * Emits a compact `summary.json` designed for the WordPress ingest endpoint.
 *
 * Playwright's built-in JSON reporter is per-test; the per-FORM detail we care about
 * lives in the annotations pushed in tests/forms.spec.ts (`discovery`, `result`, `note`)
 * plus soft-assertion failures (surfaced as result.errors). This reporter flattens the
 * run into one entry per test (= one locale × page combination) with those annotations
 * and a clear status, then writes a small top-level rollup.
 *
 * Output shape (stable contract with scripts/report-to-wp.mjs and the WP REST schema):
 * {
 *   schema: 1,
 *   status: 'passed' | 'failed',
 *   startedAt, durationMs,
 *   totals: { tests, passed, failed, skipped, flaky },
 *   run: { runId, attempt, sha, ref, runUrl },   // filled from env when present
 *   tests: [ { locale, page, title, status, durationMs, annotations, errors } ]
 * }
 */

interface TestEntry {
  locale: string;
  page: string;
  title: string;
  status: string;
  durationMs: number;
  annotations: { type: string; description?: string }[];
  errors: string[];
}

export default class SummaryReporter implements Reporter {
  private entries: TestEntry[] = [];
  private startedAt = new Date().toISOString();
  private counts = { tests: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 };

  onBegin(_config: FullConfig, _suite: Suite): void {
    this.startedAt = new Date().toISOString();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // The describe block is titled `${locale.label} — ${pagePath}` (forms.spec.ts).
    const describeTitle = test.parent?.title ?? '';
    const [locale, page] = describeTitle.includes(' — ')
      ? describeTitle.split(' — ')
      : [describeTitle, ''];

    // Playwright exposes annotations on the result (per-attempt) in current versions,
    // with the test-level list as a fallback.
    const annotations = (result.annotations ?? test.annotations ?? []).map((a) => ({
      type: a.type,
      description: a.description,
    }));

    const errors = (result.errors ?? [])
      .map((e) => (e.message ?? '').replace(/\[[0-9;]*m/g, '').trim())
      .filter(Boolean);

    // outcome() collapses retries into a stable verdict (passed/failed/flaky/skipped).
    const status = test.outcome();
    this.counts.tests++;
    if (status === 'expected') this.counts.passed++;
    else if (status === 'unexpected') this.counts.failed++;
    else if (status === 'flaky') this.counts.flaky++;
    else if (status === 'skipped') this.counts.skipped++;

    this.entries.push({
      locale: locale.trim(),
      page: page.trim(),
      title: test.title,
      status,
      durationMs: result.duration,
      annotations,
      errors,
    });
  }

  onEnd(result: FullResult): void {
    const summary = {
      schema: 1,
      status: result.status === 'passed' ? 'passed' : 'failed',
      startedAt: this.startedAt,
      durationMs: result.duration,
      totals: this.counts,
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
      tests: this.entries,
    };

    const outFile = process.env.SUMMARY_OUTFILE || 'summary.json';
    writeFileSync(outFile, JSON.stringify(summary, null, 2));
    // eslint-disable-next-line no-console
    console.log(
      `\n[summary-reporter] wrote ${outFile}: ${summary.status} ` +
        `(${this.counts.passed} passed / ${this.counts.failed} failed / ${this.counts.skipped} skipped)`,
    );
  }
}
