<?php
/**
 * Email notifications: alert only when tests are failing (a newly-failing area),
 * plus a dead-man's switch that fires when no run has been ingested recently.
 * Failures only — no email is sent when forms recover.
 *
 * @package DAC_Form_Monitor
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class DAC_FM_Notify {

	public static function init() {
		add_action( DAC_FM_HOOK_DEADMAN, array( __CLASS__, 'deadman_check' ) );
	}

	private static function alert_email() {
		$to = defined( 'DAC_FORM_ALERT_EMAIL' ) ? DAC_FORM_ALERT_EMAIL : get_option( 'admin_email' );
		return sanitize_email( (string) $to );
	}

	/**
	 * Send an admin alert. Thin wrapper so callers stay declarative.
	 */
	public static function admin_alert( $subject, $body ) {
		$to = self::alert_email();
		if ( $to ) {
			wp_mail( $to, $subject, $body );
		}
	}

	/**
	 * Decide whether an incoming run warrants an email, by diffing the failing set
	 * against the last-known failing set. Emails ONLY on a newly-failing item
	 * (pass -> fail). Stays silent on recovery and on steady-state failures already
	 * reported.
	 *
	 * @param array $summary Decoded summary payload.
	 * @param int   $post_id Stored run post id.
	 */
	public static function evaluate( $summary, $post_id ) {
		$prev = get_option( 'dac_fm_failing_state', array() );
		if ( ! is_array( $prev ) ) {
			$prev = array();
		}

		// Build the current failing set keyed by locale|page (one entry per failing test).
		$current = array();
		if ( isset( $summary['tests'] ) && is_array( $summary['tests'] ) ) {
			foreach ( $summary['tests'] as $t ) {
				$status = isset( $t['status'] ) ? $t['status'] : '';
				if ( 'unexpected' === $status || 'failed' === $status ) {
					$locale = isset( $t['locale'] ) ? (string) $t['locale'] : '?';
					$page   = isset( $t['page'] ) ? (string) $t['page'] : '?';
					$key    = $locale . ' | ' . $page;
					$errs   = isset( $t['errors'] ) && is_array( $t['errors'] ) ? $t['errors'] : array();
					$current[ $key ] = $errs;
				}
			}
		}

		$new_failures = array_diff_key( $current, $prev );
		$run_url      = isset( $summary['run']['runUrl'] ) ? (string) $summary['run']['runUrl'] : '';

		// Failures only — send on newly-failing areas; no recovery/"all passing" email.
		if ( ! empty( $new_failures ) ) {
			self::send_failure_email( $new_failures, $current, $run_url, $post_id );
		}

		// Still track the failing set so we email on NEW failures, not every failing run.
		update_option( 'dac_fm_failing_state', $current, false );
	}

	private static function send_failure_email( $new_failures, $all_failing, $run_url, $post_id ) {
		$lines   = array();
		$lines[] = 'Form tests reported NEW failures on dacgroup.com.';
		$lines[] = '';
		$lines[] = 'Newly failing:';
		foreach ( $new_failures as $key => $errors ) {
			$lines[] = '  • ' . $key;
			foreach ( (array) $errors as $e ) {
				$lines[] = '        ' . wp_strip_all_tags( (string) $e );
			}
		}
		if ( count( $all_failing ) > count( $new_failures ) ) {
			$lines[] = '';
			$lines[] = 'Also still failing:';
			foreach ( array_diff_key( $all_failing, $new_failures ) as $key => $errors ) {
				$lines[] = '  • ' . $key;
			}
		}
		$lines[] = '';
		$lines[] = 'GitHub run: ' . ( $run_url ?: 'n/a' );
		$lines[] = 'Details in WP Admin → Form Monitor → run #' . (int) $post_id;

		self::admin_alert(
			sprintf( '[DAC Form Monitor] ❌ %d form area(s) newly failing', count( $new_failures ) ),
			implode( "\n", $lines )
		);
	}

	/**
	 * Dead-man's switch: if we haven't ingested a run within the threshold, monitoring is
	 * silently broken (PAT expired, GH down, dispatch failing). Alert once until it recovers.
	 */
	public static function deadman_check() {
		$last = (int) get_option( 'dac_fm_last_ingest', 0 );

		// Don't cry wolf before the first run has ever been ingested.
		if ( $last <= 0 ) {
			return;
		}
		if ( ( time() - $last ) <= DAC_FM_DEADMAN_THRESHOLD ) {
			return;
		}
		if ( get_option( 'dac_fm_deadman_alerted' ) ) {
			return; // already alerted; wait for recovery to reset.
		}

		$mins = (int) round( ( time() - $last ) / MINUTE_IN_SECONDS );
		self::admin_alert(
			'[DAC Form Monitor] ⚠️ No form-test results received',
			"No test run has reported results in {$mins} minutes (threshold: " .
			(int) ( DAC_FM_DEADMAN_THRESHOLD / MINUTE_IN_SECONDS ) . " min).\n\n" .
			"Form monitoring may be broken: check the GitHub PAT expiry, GitHub Actions status, " .
			"and the hourly WP-Cron dispatch (last dispatch error, if any, is on the Form Monitor admin page)."
		);
		update_option( 'dac_fm_deadman_alerted', 1, false );
	}
}
