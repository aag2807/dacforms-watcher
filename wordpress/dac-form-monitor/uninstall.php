<?php
/**
 * Uninstall: remove all stored runs and plugin options.
 *
 * @package DAC_Form_Monitor
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

if ( ! defined( 'DAC_FM_CPT' ) ) {
	define( 'DAC_FM_CPT', 'dac_test_run' );
}

// Delete all run posts + their meta.
$runs = get_posts(
	array(
		'post_type'      => DAC_FM_CPT,
		'post_status'    => 'any',
		'numberposts'    => -1,
		'fields'         => 'ids',
	)
);
foreach ( $runs as $id ) {
	wp_delete_post( (int) $id, true );
}

// Remove options.
foreach ( array(
	'dac_fm_last_ingest',
	'dac_fm_last_dispatch',
	'dac_fm_dispatch_error',
	'dac_fm_failing_state',
	'dac_fm_deadman_alerted',
) as $opt ) {
	delete_option( $opt );
}

// Clear any scheduled events (defensive; deactivation already does this).
foreach ( array( 'dac_dispatch_form_tests', 'dac_form_monitor_deadman', 'dac_form_monitor_prune' ) as $hook ) {
	wp_clear_scheduled_hook( $hook );
}
