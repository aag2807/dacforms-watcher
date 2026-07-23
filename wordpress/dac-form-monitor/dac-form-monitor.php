<?php
/**
 * Plugin Name:       DAC Form Monitor
 * Description:        Ingests twice-daily Playwright form-test results (run via GitHub Actions):
 *                     admin dashboard, failure emails, dead-man's switch, on-demand "Run now".
 * Version:           1.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            DAC QA
 * License:           GPL-2.0-or-later
 *
 * Configuration (define these in wp-config.php, NOT in the database):
 *   define('DAC_GH_DISPATCH_TOKEN', '...');    // fine-grained PAT, single repo, Contents:RW
 *   define('DAC_GH_REPO', 'owner/repo');       // the repo hosting the Playwright suite
 *   define('DAC_FORM_INGEST_TOKEN', '...');    // shared bearer for the inbound results POST
 *   define('DAC_FORM_INGEST_HMAC_SECRET', '...'); // HMAC secret shared with report-to-wp.mjs
 *   // Optional:
 *   define('DAC_FORM_BASE_URL', 'https://staging.dacgroup.com'); // override target origin
 *   define('DAC_FORM_ALERT_EMAIL', 'qa@dacgroup.com');           // defaults to admin_email
 *   define('DAC_FORM_DEADMAN_HOURS', 13);      // "no results" alert window; keep > run cadence
 *
 * @package DAC_Form_Monitor
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'DAC_FM_VERSION', '1.1.0' );
define( 'DAC_FM_CPT', 'dac_test_run' );
define( 'DAC_FM_HOOK_DISPATCH', 'dac_dispatch_form_tests' );
define( 'DAC_FM_HOOK_DEADMAN', 'dac_form_monitor_deadman' );
define( 'DAC_FM_HOOK_PRUNE', 'dac_form_monitor_prune' );
define( 'DAC_FM_SCHEDULE_30', 'dac_fm_thirty_minutes' );
define( 'DAC_FM_RETENTION_DAYS', 30 );
// Alert when no run has ingested within this window. It MUST exceed the GitHub Actions
// run cadence (.github/workflows/form-tests.yml — currently twice daily, ~12h) plus slack,
// or it false-alarms between runs. Tune in one place via DAC_FORM_DEADMAN_HOURS (wp-config)
// if you change the schedule, so the two never silently desync.
define(
	'DAC_FM_DEADMAN_THRESHOLD',
	( defined( 'DAC_FORM_DEADMAN_HOURS' ) ? (int) DAC_FORM_DEADMAN_HOURS : 13 ) * HOUR_IN_SECONDS
);
define( 'DAC_FM_DIR', plugin_dir_path( __FILE__ ) );

require_once DAC_FM_DIR . 'includes/class-cpt.php';
require_once DAC_FM_DIR . 'includes/class-dispatch.php';
require_once DAC_FM_DIR . 'includes/class-rest.php';
require_once DAC_FM_DIR . 'includes/class-notify.php';
require_once DAC_FM_DIR . 'includes/class-admin.php';

/**
 * Add a 30-minute cron interval used by the dead-man's switch.
 */
add_filter(
	'cron_schedules',
	static function ( $schedules ) {
		$schedules[ DAC_FM_SCHEDULE_30 ] = array(
			'interval' => 30 * MINUTE_IN_SECONDS,
			'display'  => __( 'Every 30 Minutes (DAC Form Monitor)', 'dac-form-monitor' ),
		);
		return $schedules;
	}
);

// Wire the components.
DAC_FM_CPT_Registrar::init();
DAC_FM_Dispatch::init();
DAC_FM_Rest::init();
DAC_FM_Notify::init();
DAC_FM_Admin::init();

/**
 * One-time upgrade routine. Runs on load whenever the stored version differs from the
 * plugin's, so in-place updates (new code deployed without re-activation) reliably apply
 * migrations — the activation hook does NOT fire on an already-active site.
 */
add_action(
	'init',
	static function () {
		if ( get_option( 'dac_fm_version' ) === DAC_FM_VERSION ) {
			return;
		}
		// GitHub Actions now owns scheduling: ensure no WP dispatch cron lingers from an
		// older version, which would double-trigger runs alongside the Actions schedule.
		wp_clear_scheduled_hook( DAC_FM_HOOK_DISPATCH );
		update_option( 'dac_fm_version', DAC_FM_VERSION, false );
	}
);

/**
 * Activation: register the CPT (so rewrite state is correct) and schedule cron events.
 */
register_activation_hook(
	__FILE__,
	static function () {
		DAC_FM_CPT_Registrar::register();

		// Scheduling is owned by the GitHub Actions cron (twice daily). WP does NOT
		// auto-dispatch — clear any dispatch cron left by a previous version so the two
		// schedulers can't double-trigger. The admin "Run now" button still dispatches
		// on demand (it calls DAC_FM_Dispatch::run() directly, not via this hook).
		wp_clear_scheduled_hook( DAC_FM_HOOK_DISPATCH );
		if ( ! wp_next_scheduled( DAC_FM_HOOK_DEADMAN ) ) {
			wp_schedule_event( time() + ( 5 * MINUTE_IN_SECONDS ), DAC_FM_SCHEDULE_30, DAC_FM_HOOK_DEADMAN );
		}
		if ( ! wp_next_scheduled( DAC_FM_HOOK_PRUNE ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', DAC_FM_HOOK_PRUNE );
		}
		flush_rewrite_rules();
	}
);

/**
 * Deactivation: clear all scheduled events. Data (CPT rows) is preserved; use uninstall to purge.
 */
register_deactivation_hook(
	__FILE__,
	static function () {
		wp_clear_scheduled_hook( DAC_FM_HOOK_DISPATCH );
		wp_clear_scheduled_hook( DAC_FM_HOOK_DEADMAN );
		wp_clear_scheduled_hook( DAC_FM_HOOK_PRUNE );
		flush_rewrite_rules();
	}
);
