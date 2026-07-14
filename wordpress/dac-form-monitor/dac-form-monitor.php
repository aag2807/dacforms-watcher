<?php
/**
 * Plugin Name:       DAC Form Monitor
 * Description:        Schedules hourly Playwright form tests (via GitHub Actions) and ingests
 *                     the results: admin dashboard, failure emails, and a dead-man's switch.
 * Version:           1.0.0
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
 *
 * @package DAC_Form_Monitor
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'DAC_FM_VERSION', '1.0.0' );
define( 'DAC_FM_CPT', 'dac_test_run' );
define( 'DAC_FM_HOOK_DISPATCH', 'dac_dispatch_form_tests' );
define( 'DAC_FM_HOOK_DEADMAN', 'dac_form_monitor_deadman' );
define( 'DAC_FM_HOOK_PRUNE', 'dac_form_monitor_prune' );
define( 'DAC_FM_SCHEDULE_30', 'dac_fm_thirty_minutes' );
define( 'DAC_FM_RETENTION_DAYS', 30 );
define( 'DAC_FM_DEADMAN_THRESHOLD', 90 * MINUTE_IN_SECONDS );
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
 * Activation: register the CPT (so rewrite state is correct) and schedule cron events.
 */
register_activation_hook(
	__FILE__,
	static function () {
		DAC_FM_CPT_Registrar::register();

		if ( ! wp_next_scheduled( DAC_FM_HOOK_DISPATCH ) ) {
			// Start on the next hour boundary-ish; interval schedule, not wall-clock.
			wp_schedule_event( time() + MINUTE_IN_SECONDS, 'hourly', DAC_FM_HOOK_DISPATCH );
		}
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
