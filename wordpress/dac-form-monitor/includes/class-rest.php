<?php
/**
 * REST ingest endpoint: receives run summaries from GitHub Actions.
 *
 * Auth is layered and all checks are constant-time where it matters:
 *   Authorization: Bearer <DAC_FORM_INGEST_TOKEN>
 *   X-DAC-Timestamp: <unix seconds>              (±5 min skew, anti-replay)
 *   X-DAC-Signature: sha256=<hex HMAC over "<ts>.<raw body>">
 *
 * @package DAC_Form_Monitor
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class DAC_FM_Rest {

	const NAMESPACE   = 'dac-monitor/v1';
	const ROUTE       = '/runs';
	const SKEW        = 300; // seconds

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	public static function register_routes() {
		register_rest_route(
			self::NAMESPACE,
			self::ROUTE,
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'handle' ),
				'permission_callback' => array( __CLASS__, 'authenticate' ),
			)
		);
	}

	/**
	 * Verify bearer token, timestamp freshness, and HMAC signature over the raw body.
	 *
	 * @param WP_REST_Request $request
	 * @return true|WP_Error
	 */
	public static function authenticate( $request ) {
		if ( ! defined( 'DAC_FORM_INGEST_TOKEN' ) || ! defined( 'DAC_FORM_INGEST_HMAC_SECRET' ) ) {
			return new WP_Error( 'dac_fm_not_configured', 'Ingest not configured.', array( 'status' => 503 ) );
		}

		// 1) Bearer token (possession), constant-time.
		$auth = (string) $request->get_header( 'authorization' );
		$sent = '';
		if ( preg_match( '/^Bearer\s+(.+)$/i', $auth, $m ) ) {
			$sent = trim( $m[1] );
		}
		if ( ! self::const_eq( $sent, (string) DAC_FORM_INGEST_TOKEN ) ) {
			return new WP_Error( 'dac_fm_bad_token', 'Invalid token.', array( 'status' => 403 ) );
		}

		// 2) Timestamp freshness (anti-replay).
		$ts = (int) $request->get_header( 'x-dac-timestamp' );
		if ( $ts <= 0 || abs( time() - $ts ) > self::SKEW ) {
			return new WP_Error( 'dac_fm_stale', 'Stale or missing timestamp.', array( 'status' => 401 ) );
		}

		// 3) HMAC over "<ts>.<raw body>" (integrity + tamper protection).
		$sig_header = (string) $request->get_header( 'x-dac-signature' );
		$raw        = $request->get_body();
		$expected   = 'sha256=' . hash_hmac( 'sha256', $ts . '.' . $raw, DAC_FORM_INGEST_HMAC_SECRET );
		if ( ! self::const_eq( $sig_header, $expected ) ) {
			return new WP_Error( 'dac_fm_bad_sig', 'Invalid signature.', array( 'status' => 401 ) );
		}

		return true;
	}

	/**
	 * Store the run (idempotent upsert by GitHub run id) and trigger notifications.
	 *
	 * @param WP_REST_Request $request
	 * @return WP_REST_Response|WP_Error
	 */
	public static function handle( $request ) {
		$data = json_decode( $request->get_body(), true );
		if ( ! is_array( $data ) || ! isset( $data['status'], $data['totals'] ) ) {
			return new WP_Error( 'dac_fm_bad_payload', 'Malformed summary.', array( 'status' => 400 ) );
		}

		$run     = isset( $data['run'] ) && is_array( $data['run'] ) ? $data['run'] : array();
		$totals  = is_array( $data['totals'] ) ? $data['totals'] : array();
		$run_id  = isset( $run['runId'] ) ? sanitize_text_field( (string) $run['runId'] ) : '';
		$status  = 'passed' === $data['status'] ? 'passed' : 'failed';
		$failed  = isset( $totals['failed'] ) ? (int) $totals['failed'] : 0;
		$passed  = isset( $totals['passed'] ) ? (int) $totals['passed'] : 0;
		$total   = isset( $totals['tests'] ) ? (int) $totals['tests'] : 0;
		$run_url = isset( $run['runUrl'] ) ? esc_url_raw( (string) $run['runUrl'] ) : '';
		$sha     = isset( $run['sha'] ) ? sanitize_text_field( (string) $run['sha'] ) : '';

		// Store the summary verbatim (it contains only metadata + assertion text, no field values).
		$content = wp_json_encode( $data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );

		$existing = DAC_FM_CPT_Registrar::find_by_run_id( $run_id );
		$postarr  = array(
			'post_type'    => DAC_FM_CPT,
			'post_status'  => 'publish',
			'post_title'   => sprintf(
				'%s — run %s (%d/%d passed)',
				strtoupper( $status ),
				'' !== $run_id ? $run_id : 'unknown',
				$passed,
				$total
			),
			'post_content' => $content,
		);

		if ( $existing ) {
			$postarr['ID'] = $existing;
			$post_id       = wp_update_post( $postarr, true );
		} else {
			$post_id = wp_insert_post( $postarr, true );
		}

		if ( is_wp_error( $post_id ) ) {
			return new WP_Error( 'dac_fm_store_failed', $post_id->get_error_message(), array( 'status' => 500 ) );
		}

		update_post_meta( $post_id, '_dac_run_id', $run_id );
		update_post_meta( $post_id, '_dac_status', $status );
		update_post_meta( $post_id, '_dac_failed_count', $failed );
		update_post_meta( $post_id, '_dac_passed_count', $passed );
		update_post_meta( $post_id, '_dac_total_count', $total );
		update_post_meta( $post_id, '_dac_run_url', $run_url );
		update_post_meta( $post_id, '_dac_sha', $sha );

		// Feed the dead-man's switch and let the notifier decide on emails.
		update_option( 'dac_fm_last_ingest', time(), false );
		delete_option( 'dac_fm_deadman_alerted' );

		DAC_FM_Notify::evaluate( $data, $post_id );

		return new WP_REST_Response(
			array(
				'ok'      => true,
				'post_id' => (int) $post_id,
				'updated' => (bool) $existing,
			),
			$existing ? 200 : 201
		);
	}

	/**
	 * Constant-time string comparison via hash_equals with a length guard.
	 */
	private static function const_eq( $a, $b ) {
		if ( '' === $a || '' === $b ) {
			return false;
		}
		return hash_equals( (string) $b, (string) $a );
	}
}
