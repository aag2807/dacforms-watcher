<?php
/**
 * Fires a GitHub repository_dispatch to trigger the Playwright workflow.
 *
 * @package DAC_Form_Monitor
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class DAC_FM_Dispatch {

	public static function init() {
		add_action( DAC_FM_HOOK_DISPATCH, array( __CLASS__, 'run' ) );
	}

	/**
	 * @return true|WP_Error
	 */
	public static function run() {
		if ( ! defined( 'DAC_GH_DISPATCH_TOKEN' ) || ! defined( 'DAC_GH_REPO' ) ) {
			$err = new WP_Error(
				'dac_fm_not_configured',
				'DAC_GH_DISPATCH_TOKEN / DAC_GH_REPO are not defined in wp-config.php.'
			);
			self::log_failure( $err->get_error_message() );
			return $err;
		}

		$repo    = DAC_GH_REPO; // "owner/repo"
		$api_url = sprintf( 'https://api.github.com/repos/%s/dispatches', $repo );

		$payload = array(
			'event_type'     => 'run-form-tests',
			'client_payload' => array(
				'base_url'   => defined( 'DAC_FORM_BASE_URL' ) ? DAC_FORM_BASE_URL : '',
				'trigger'    => 'wp-cron',
				'wp_site'    => home_url(),
				'started_at' => gmdate( 'c' ),
			),
		);

		$response = wp_remote_post(
			$api_url,
			array(
				'timeout' => 20,
				'headers' => array(
					'Accept'               => 'application/vnd.github+json',
					'Authorization'        => 'Bearer ' . DAC_GH_DISPATCH_TOKEN,
					'X-GitHub-Api-Version' => '2022-11-28',
					'Content-Type'         => 'application/json',
					'User-Agent'           => 'DAC-Form-Monitor/' . DAC_FM_VERSION,
				),
				'body'    => wp_json_encode( $payload ),
			)
		);

		if ( is_wp_error( $response ) ) {
			self::log_failure( 'Dispatch transport error: ' . $response->get_error_message() );
			return $response;
		}

		$code = (int) wp_remote_retrieve_response_code( $response );
		// GitHub returns 204 No Content on a successful dispatch.
		if ( 204 !== $code ) {
			$body = wp_remote_retrieve_body( $response );
			$msg  = sprintf( 'Dispatch failed: HTTP %d — %s', $code, wp_strip_all_tags( substr( (string) $body, 0, 300 ) ) );
			self::log_failure( $msg );
			return new WP_Error( 'dac_fm_dispatch_http', $msg );
		}

		update_option( 'dac_fm_last_dispatch', time(), false );
		delete_option( 'dac_fm_dispatch_error' );
		return true;
	}

	private static function log_failure( $message ) {
		update_option( 'dac_fm_dispatch_error', array( 'at' => time(), 'message' => $message ), false );
		// Surface serious wiring problems to the admin immediately.
		DAC_FM_Notify::admin_alert(
			'[DAC Form Monitor] Could not trigger form tests',
			"The hourly dispatch to GitHub Actions failed:\n\n{$message}\n\nForm tests are NOT running until this is resolved."
		);
	}
}
