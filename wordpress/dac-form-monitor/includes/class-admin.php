<?php
/**
 * Admin UI: a runs list page, a dashboard status widget, and a manual "Run now" button.
 *
 * @package DAC_Form_Monitor
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class DAC_FM_Admin {

	const CAP  = 'manage_options';
	const SLUG = 'dac-form-monitor';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'wp_dashboard_setup', array( __CLASS__, 'dashboard_widget' ) );
		add_action( 'admin_post_dac_fm_run_now', array( __CLASS__, 'handle_run_now' ) );
		add_action( 'admin_notices', array( __CLASS__, 'config_notice' ) );
	}

	public static function menu() {
		add_menu_page(
			__( 'Form Monitor', 'dac-form-monitor' ),
			__( 'Form Monitor', 'dac-form-monitor' ),
			self::CAP,
			self::SLUG,
			array( __CLASS__, 'render_page' ),
			'dashicons-forms',
			76
		);
	}

	/**
	 * Warn if the plugin isn't fully configured (missing wp-config constants).
	 */
	public static function config_notice() {
		if ( ! current_user_can( self::CAP ) ) {
			return;
		}
		$missing = array();
		foreach ( array( 'DAC_GH_DISPATCH_TOKEN', 'DAC_GH_REPO', 'DAC_FORM_INGEST_TOKEN', 'DAC_FORM_INGEST_HMAC_SECRET' ) as $c ) {
			if ( ! defined( $c ) ) {
				$missing[] = $c;
			}
		}
		if ( $missing ) {
			echo '<div class="notice notice-warning"><p><strong>DAC Form Monitor:</strong> define '
				. esc_html( implode( ', ', $missing ) )
				. ' in wp-config.php to enable dispatch + ingest.</p></div>';
		}
	}

	public static function dashboard_widget() {
		wp_add_dashboard_widget(
			'dac_fm_widget',
			__( 'Form Test Status', 'dac-form-monitor' ),
			array( __CLASS__, 'render_widget' )
		);
	}

	private static function latest_run() {
		$q = new WP_Query(
			array(
				'post_type'      => DAC_FM_CPT,
				'post_status'    => 'publish',
				'posts_per_page' => 1,
				'orderby'        => 'date',
				'order'          => 'DESC',
				'no_found_rows'  => true,
			)
		);
		return $q->have_posts() ? $q->posts[0] : null;
	}

	public static function render_widget() {
		$run = self::latest_run();
		if ( ! $run ) {
			echo '<p>' . esc_html__( 'No test runs recorded yet.', 'dac-form-monitor' ) . '</p>';
			return;
		}
		$status  = get_post_meta( $run->ID, '_dac_status', true );
		$failed  = (int) get_post_meta( $run->ID, '_dac_failed_count', true );
		$passed  = (int) get_post_meta( $run->ID, '_dac_passed_count', true );
		$run_url = get_post_meta( $run->ID, '_dac_run_url', true );
		$ok      = ( 'passed' === $status );

		printf(
			'<p style="font-size:15px"><span style="font-size:18px">%s</span> <strong>%s</strong> — %d passed, %d failed<br><span style="color:#666">%s ago</span></p>',
			$ok ? '✅' : '❌',
			esc_html( ucfirst( (string) $status ) ),
			$passed,
			$failed,
			esc_html( human_time_diff( get_post_time( 'U', true, $run ) ) )
		);
		echo '<p>';
		printf(
			'<a href="%s" class="button">%s</a> ',
			esc_url( admin_url( 'admin.php?page=' . self::SLUG ) ),
			esc_html__( 'All runs', 'dac-form-monitor' )
		);
		if ( $run_url ) {
			printf( '<a href="%s" class="button" target="_blank" rel="noopener">%s</a>', esc_url( $run_url ), esc_html__( 'GitHub run', 'dac-form-monitor' ) );
		}
		echo '</p>';
	}

	public static function render_page() {
		if ( ! current_user_can( self::CAP ) ) {
			wp_die( esc_html__( 'Insufficient permissions.', 'dac-form-monitor' ) );
		}

		echo '<div class="wrap"><h1>' . esc_html__( 'Form Monitor', 'dac-form-monitor' ) . '</h1>';

		// Run-now button.
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin:1em 0">';
		echo '<input type="hidden" name="action" value="dac_fm_run_now">';
		wp_nonce_field( 'dac_fm_run_now' );
		submit_button( __( 'Run form tests now', 'dac-form-monitor' ), 'primary', 'submit', false );
		echo '</form>';

		// Last dispatch error, if any.
		$err = get_option( 'dac_fm_dispatch_error' );
		if ( is_array( $err ) && ! empty( $err['message'] ) ) {
			echo '<div class="notice notice-error inline"><p><strong>' . esc_html__( 'Last dispatch error:', 'dac-form-monitor' ) . '</strong> '
				. esc_html( $err['message'] ) . '</p></div>';
		}

		// Runs table.
		$q = new WP_Query(
			array(
				'post_type'      => DAC_FM_CPT,
				'post_status'    => 'publish',
				'posts_per_page' => 50,
				'orderby'        => 'date',
				'order'          => 'DESC',
				'no_found_rows'  => true,
			)
		);

		echo '<table class="widefat striped"><thead><tr>'
			. '<th>' . esc_html__( 'When', 'dac-form-monitor' ) . '</th>'
			. '<th>' . esc_html__( 'Status', 'dac-form-monitor' ) . '</th>'
			. '<th>' . esc_html__( 'Passed', 'dac-form-monitor' ) . '</th>'
			. '<th>' . esc_html__( 'Failed', 'dac-form-monitor' ) . '</th>'
			. '<th>' . esc_html__( 'Run', 'dac-form-monitor' ) . '</th>'
			. '</tr></thead><tbody>';

		if ( ! $q->have_posts() ) {
			echo '<tr><td colspan="5">' . esc_html__( 'No runs yet.', 'dac-form-monitor' ) . '</td></tr>';
		}
		foreach ( $q->posts as $post ) {
			$status  = get_post_meta( $post->ID, '_dac_status', true );
			$failed  = (int) get_post_meta( $post->ID, '_dac_failed_count', true );
			$passed  = (int) get_post_meta( $post->ID, '_dac_passed_count', true );
			$run_url = get_post_meta( $post->ID, '_dac_run_url', true );
			$ok      = ( 'passed' === $status );
			echo '<tr>';
			echo '<td>' . esc_html( get_post_time( 'Y-m-d H:i', true, $post ) ) . ' UTC</td>';
			echo '<td>' . ( $ok ? '✅ ' : '❌ ' ) . esc_html( ucfirst( (string) $status ) ) . '</td>';
			echo '<td>' . (int) $passed . '</td>';
			echo '<td>' . (int) $failed . '</td>';
			echo '<td>' . ( $run_url ? '<a href="' . esc_url( $run_url ) . '" target="_blank" rel="noopener">GitHub ↗</a>' : '—' ) . '</td>';
			echo '</tr>';
		}
		echo '</tbody></table></div>';
	}

	/**
	 * Handle the "Run now" button: verify nonce + cap, then dispatch.
	 */
	public static function handle_run_now() {
		if ( ! current_user_can( self::CAP ) ) {
			wp_die( esc_html__( 'Insufficient permissions.', 'dac-form-monitor' ) );
		}
		check_admin_referer( 'dac_fm_run_now' );

		$result  = DAC_FM_Dispatch::run();
		$notice  = is_wp_error( $result ) ? 'dispatch_error' : 'dispatched';
		wp_safe_redirect( add_query_arg( 'dac_fm_notice', $notice, admin_url( 'admin.php?page=' . self::SLUG ) ) );
		exit;
	}
}
