<?php

header('Content-Type: application/json; charset=utf-8');

require_once($_SERVER['DOCUMENT_ROOT'] . '/config.php');
require_once($_SERVER['DOCUMENT_ROOT'] . '/app/controllers/recharge_binance.php');

// CSRF disabled on customer side per user request
// CSRFProtection::validateOrDie();

if (empty($_SESSION['username'])) {
    die(json_encode(['status' => 'error', 'msg' => 'Vui lòng đăng nhập để thanh toán ! ']));
}

$auth = $duogxaolin->auth();
if (!$auth) {
    die(json_encode(['status' => 'error', 'msg' => 'Phiên đăng nhập không hợp lệ']));
}

if (!binance_enabled()) {
    die(json_encode(['status' => 'error', 'msg' => 'Phương thức Binance USDT hiện không khả dụng']));
}

$providerSlug = trim((string) xss($_POST['provider_slug'] ?? ''));
if ($providerSlug === '') {
    die(json_encode(['status' => 'error', 'msg' => 'Provider Binance không hợp lệ']));
}

$provider = get_binance_provider_by_slug($providerSlug, true);
if (!$provider) {
    die(json_encode(['status' => 'error', 'msg' => 'Provider Binance không tồn tại hoặc đang tắt']));
}

$config = binance_provider_required_snapshot($provider);
$usdtAmount = str_replace(',', '.', (string) xss($_POST['usdt_amount'] ?? ''));
if ($usdtAmount === '' || !is_numeric($usdtAmount)) {
    die(json_encode(['status' => 'error', 'msg' => 'Số lượng USDT không hợp lệ']));
}

$usdtAmount = round((float) $usdtAmount, 8);
if ($usdtAmount <= 0) {
    die(json_encode(['status' => 'error', 'msg' => 'Số lượng USDT phải lớn hơn 0']));
}

$minUsdt = (float) ($config['min_usdt'] ?? 1);
if ($minUsdt > 0 && $usdtAmount < $minUsdt) {
    die(json_encode(['status' => 'error', 'msg' => 'Số lượng USDT tối thiểu là ' . rtrim(rtrim(number_format($minUsdt, 8, '.', ''), '0'), '.') ]));
}

if (trim((string) $config['pay_uid']) === '' && trim((string) $config['account_name']) === '') {
    die(json_encode(['status' => 'error', 'msg' => 'Cấu hình Binance chưa đầy đủ, vui lòng liên hệ quản trị viên']));
}

$pendingBankCount = (int) $duogxaolin->num_rows(
    "SELECT * FROM `autobank` WHERE `user_id` = ? AND `status` = 'xuly'
       AND DAY(FROM_UNIXTIME(`time`)) = DAY(NOW())
       AND MONTH(FROM_UNIXTIME(`time`)) = MONTH(NOW())
       AND YEAR(FROM_UNIXTIME(`time`)) = YEAR(NOW())",
    [$auth['id']]
);

// This customer's own unpaid requests past the expiry time are closed first (the payment cron does it for everyone, but it may be off):
// otherwise stale ones keep counting towards the limit of 10 open requests a day and lock the customer out.
try {
    $ttlMinutes = max(15, (int) ($duogxaolin->site('binance_request_ttl_minutes') ?: 120));
    $duogxaolin->query(
        "UPDATE `recharge_binance` SET `status` = 'huy' WHERE `user_id` = ? AND `status` = 'xuly' AND `created_at` < ?",
        [$auth['id'], time() - $ttlMinutes * 60]
    );
} catch (Throwable $e) {
    log_once('binance:expire-own', 'binance own-request expiry failed: ' . $e->getMessage(), 3600);
}

$pendingBinanceCount = 0;
try {
    $pendingBinanceCount = (int) $duogxaolin->num_rows(
        "SELECT * FROM `recharge_binance` WHERE `user_id` = ? AND `status` = 'xuly'
           AND DAY(FROM_UNIXTIME(`created_at`)) = DAY(NOW())
           AND MONTH(FROM_UNIXTIME(`created_at`)) = MONTH(NOW())
           AND YEAR(FROM_UNIXTIME(`created_at`)) = YEAR(NOW())",
        [$auth['id']]
    );
} catch (Exception $e) {
    $pendingBinanceCount = 0;
}

if (($pendingBankCount + $pendingBinanceCount) > 10) {
    die(json_encode(['status' => 'error', 'msg' => 'Bạn còn quá nhiều đơn chưa thanh thanh toán ! ']));
}

$requestId = $duogxaolin->site('noi_dung_nap') . generate_recharge_request_id();
$rateUsd = binance_rate_usd();
$creditedMoney = round($usdtAmount * $rateUsd, 2);
$timeNow = time();

$promotionFees = 0;
$moneySBinance = $creditedMoney;
$promotionRate = (float) $duogxaolin->site('promotion');
if ($promotionRate > 0) {
    $promotionTime = $duogxaolin->site('promotion_time');
    $promotionValue = (float) $duogxaolin->site('promotion_value');
    $timeCheck = 0;
    if ($promotionTime) {
        try { $timeCheck = (new DateTime($promotionTime))->getTimestamp(); } catch (Exception $e) {}
    }
    if (time() <= $timeCheck && $creditedMoney >= $promotionValue) {
        $promotionFees = $promotionRate;
        $moneySBinance = round($creditedMoney + ($creditedMoney * $promotionRate / 100), 2);
    }
}

$insertData = [
    'request_id' => $requestId,
    'user_id' => $auth['id'],
    'status' => 'xuly',
    'usdt_amount' => $usdtAmount,
    'rate_usd' => $rateUsd,
    'money' => $creditedMoney,
    'money_s' => $moneySBinance,
    'fees' => $promotionFees,
    'display_currency' => $duogxaolin->site('c'),
    'provider_id' => $config['provider_id'],
    'display_name_snapshot' => $config['display_name'],
    'provider_slug_snapshot' => $config['slug'],
    'provider_status_snapshot' => $config['status'],
    'provider_qr_image_id_snapshot' => $config['qr_image_id'],
    'note_snapshot' => $config['note'],
    'provider_note_snapshot' => $config['provider_note'],
    'provider_instructions_snapshot' => $config['instructions'],
    'provider_api_key_hash' => $config['api_key_hash'],
    'binance_config_key' => 'provider:' . $config['slug'],
    'pay_uid' => $config['pay_uid'],
    'account_name' => $config['account_name'],
    'qr_image_path' => $config['qr_image_path'],
    'comment' => '',
    'created_at' => $timeNow,
    'updated_at' => $timeNow,
];

try {
    $created = $duogxaolin->insert('recharge_binance', $insertData);
} catch (Exception $e) {
    die(json_encode(['status' => 'error', 'msg' => 'Không thể tạo đơn Binance lúc này']));
}

if (!$created) {
    die(json_encode(['status' => 'error', 'msg' => 'Lỗi Hệ Thống ! ']));
}

die(json_encode([
    'status' => 'success',
    'msg' => 'Tạo Yêu Cầu Thành Công ! ',
    'href' => '/recharge/order/' . $requestId,
]));
