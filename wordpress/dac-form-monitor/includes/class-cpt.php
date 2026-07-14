<?php
/**
 * Custom post type that stores each test run, plus retention pruning.
 *
 * @package DAC_Form_Monitor
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class DAC_FM_CPT_Registrar {

	public static function init() {
		add_action( 'init', array( __CLASS__, 'register' ) );
		add_action( DAC_FM_HOOK_PRUNE, array( __CLASS__, 'prune' ) );
	}

	/**
	 * Register the run CPT. Not public (admin-only), not searchable, no front-end route.
	 */
	public static function register() {
		register_post_type(
			DAC_FM_CPT,
			array(
				'labels'          => array(
					'name'          => __( 'Form Test Runs', 'dac-form-monitor' ),
					'singular_name' => __( 'Form Test Run', 'dac-form-monitor' ),
				),
				'public'          => false,
				'show_ui'         => true,
				'show_in_menu'    => false, // surfaced under our own admin menu instead
				'show_in_rest'    => false,
				'has_archive'     => false,
				'rewrite'         => false,
				'exclude_from_search' => true,
				'capability_type' => 'post',
				'capabilities'    => array( 'create_posts' => 'do_not_allow' ), // created only via ingest
				'map_meta_cap'    => true,
				'supports'        => array( 'title' ),
			)
		);
	}

	/**
	 * Find an existing run post by GitHub run id (for idempotent upsert).
	 *
	 * @param string $run_id
	 * @return int Post ID or 0.
	 */
	public static function find_by_run_id( $run_id ) {
		if ( '' === (string) $run_id ) {
			return 0;
		}
		$q = new WP_Query(
			array(
				'post_type'      => DAC_FM_CPT,
				'post_status'    => 'any',
				'posts_per_page' => 1,
				'fields'         => 'ids',
				'no_found_rows'  => true,
				'meta_query'     => array(
					array(
						'key'   => '_dac_run_id',
						'value' => (string) $run_id,
					),
				),
			)
		);
		return $q->have_posts() ? (int) $q->posts[0] : 0;
	}

	/**
	 * Delete runs older than the retention window.
	 */
	public static function prune() {
		$cutoff = gmdate( 'Y-m-d H:i:s', time() - ( DAC_FM_RETENTION_DAYS * DAY_IN_SECONDS ) );
		$q      = new WP_Query(
			array(
				'post_type'      => DAC_FM_CPT,
				'post_status'    => 'any',
				'posts_per_page' => 200,
				'fields'         => 'ids',
				'no_found_rows'  => true,
				'date_query'     => array(
					array(
						'column' => 'post_date_gmt',
						'before' => $cutoff,
					),
				),
			)
		);
		foreach ( $q->posts as $pid ) {
			wp_delete_post( (int) $pid, true );
		}
	}
}
