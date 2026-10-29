<?php

require_once($_SERVER['DOCUMENT_ROOT'] . '/config.php');
require_once($_SERVER['DOCUMENT_ROOT'] . '/app/controllers/recharge_binance.php');

// CSRF disabled on customer side per user request
// CSRFProtection::validateOrDie();

if (empty($_SESSION['username'])) {
    $return['status'] = 'error';
    $return['msg']   = 'Vui lòng đăng nhập để thanh toán ! ';
    die(json_encode($return));
}
$bank_id = xss($_POST['bank']);
$bank = $duogxaolin->get_row("SELECT * FROM `bank` WHERE `id` = ?", [$bank_id]);
if (!$bank) {
    $return['status'] = 'error';
    $return['msg']   = 'Loại Thanh Toán Không Hợp Lệ ! ';
    die(json_encode($return));
}
if ($bank['type'] == 'card') {
    require_once('card.php');
} elseif ($bank['type'] == 'binance') {
    require_once('binance.php');
} else {
    // "100.000", "100,000" and "1.000.000" are how customers write 100 thousand and a million: the old str_replace(',', '.') + is_numeric
    // read them as 100 (then refused as under the minimum) or refused them, and accepted exponent forms like 3.4e22.
    $moneyParsed = parse_money_input($_POST['money'] ?? '');
    if ($moneyParsed === null) {
        $return['status'] = 'error';
        $return['msg']   = 'Số Tiền Không Hợp Lệ !';
        die(json_encode($return));
    }
    $money    = $moneyParsed;
    $amount   = $moneyParsed; // the promotion threshold below compares numbers, not the typed text
    $fees     = str_replace(',', '.', $duogxaolin->site('promotion'));
    $discount = 0;
    $money_s = $money;
    if ($duogxaolin->site('promotion') > 0) {
        $time_check = new DateTime($duogxaolin->site('promotion_time'));
        $time_check = $time_check->getTimestamp();
      if (time() <= $time_check) {
        if ($amount >= $duogxaolin->site('promotion_value')) {
        $discount = is_numeric($fees) ? $fees : 0;
        $money_s = $money + ($money * $duogxaolin->site('promotion') / 100);
          }
        }
     }
    $pendingBank = $duogxaolin->num_rows("SELECT * FROM `autobank` WHERE `user_id` = ? AND `status` = 'xuly'
           AND DAY(FROM_UNIXTIME(`time`)) = DAY(NOW())
           AND MONTH(FROM_UNIXTIME(`time`)) = MONTH(NOW())
           AND YEAR(FROM_UNIXTIME(`time`)) = YEAR(NOW())", [$auth['id']]);
    $pendingBinance = 0;
    try {
        $pendingBinance = $duogxaolin->num_rows("SELECT * FROM `recharge_binance` WHERE `user_id` = ? AND `status` = 'xuly'
           AND DAY(FROM_UNIXTIME(`created_at`)) = DAY(NOW())
           AND MONTH(FROM_UNIXTIME(`created_at`)) = MONTH(NOW())
           AND YEAR(FROM_UNIXTIME(`created_at`)) = YEAR(NOW())", [$auth['id']]);
    } catch (Exception $e) {}
    if (($pendingBank + $pendingBinance) > 10) {
        $return['status'] = 'error';
        $return['msg']   = 'Bạn còn quá nhiều đơn chưa thanh thanh toán ! ';
        die(json_encode($return));
    }
    $request_id = generate_recharge_request_id();

    if ($bank['type'] == 'bank') {
        require_once('bank.php');
    } else {
        $return['status'] = 'error';
        $return['msg']   = 'Loại Thanh Toán Không Hợp Lệ ! ';
        die(json_encode($return));
    }
}
