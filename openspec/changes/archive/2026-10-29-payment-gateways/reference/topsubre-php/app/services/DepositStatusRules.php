<?php

/**
 * Which status changes an admin may make by hand on a bank deposit (table autobank, /admin/recharge/list).
 *
 * The bank cron (processing/payment/bank.php) matches a transfer to a deposit in status "xuly" and sets "congtien";
 * processing/payment/pay.php then credits the user and sets "hoantat". Moving a finished deposit back to "xuly" or
 * "congtien" by hand made the cron match the same transfer again and credit the customer a second time.
 */
final class DepositStatusRules
{
    /** Money was credited, or the next cron run will credit it. */
    private const CREDITED = ['hoantat', 'congtien'];

    /** Returns the reason a manual change from $old to $new is refused, or null when it is allowed. */
    public static function check(string $old, string $new, $transId): ?string
    {
        if ($old === $new) {
            return null;
        }
        // set by the system when a transfer matched; setting it by hand makes the cron credit the user
        if ($new === 'congtien') {
            return 'Trạng thái "Chờ cộng tiền" do hệ thống đặt khi khớp giao dịch, không đặt bằng tay';
        }
        if (in_array($old, self::CREDITED, true)) {
            return 'Đơn đã (hoặc sắp) được cộng tiền nên không thể đổi trạng thái, tránh cộng tiền hai lần';
        }
        // a deposit that already carries a bank transaction id would be matched to that transfer again
        if ($new === 'xuly' && trim((string) $transId) !== '') {
            return 'Đơn đã có mã giao dịch ngân hàng nên không thể chuyển lại "Đang xử lý"';
        }
        return null;
    }
}
