<?php

header('Content-Type: application/json; charset=utf-8');

require_once $_SERVER['DOCUMENT_ROOT'] . '/config.php';
require_once $_SERVER['DOCUMENT_ROOT'] . '/app/controllers/recharge_binance.php';
require_once $_SERVER['DOCUMENT_ROOT'] . '/app/models/BinanceProvider.php';

const BINANCE_PROCESSOR_API_BASE = 'https://api.binance.com';
const BINANCE_PROCESSOR_HISTORY_ENDPOINT = '/sapi/v1/pay/transactions';
const BINANCE_RECONCILIATION_LOOKBACK_DAYS = 30;
const BINANCE_RECONCILIATION_FETCH_LIMIT = 100;
const BINANCE_RECONCILIATION_AMOUNT_TOLERANCE = 0.00000001;

$GLOBALS['binance_cron_response'] = [
    'status' => 'success',
    'provider' => null,
    'fetched_count' => 0,
    'processed_count' => 0,
    'transactions' => [],
    'errors' => [],
    'timestamp' => time(),
];

$hash = isset($_GET['hash']) ? trim((string) $_GET['hash']) : '';
if ($hash === '') {
    http_response_code(400);
    die(json_encode(['status' => 'error', 'error' => 'Missing Binance hash parameter', 'timestamp' => time()]));
}

if (!preg_match('/^[a-f0-9]{64}$/i', $hash)) {
    http_response_code(400);
    die(json_encode(['status' => 'error', 'error' => 'Invalid hash format', 'timestamp' => time()]));
}

$cronJob = $duogxaolin->get_row(
    "SELECT * FROM `cron` WHERE `hash` = ? AND `type` = 'binance_payment'",
    [$hash]
);

if (!$cronJob) {
    http_response_code(404);
    die(json_encode(['status' => 'error', 'error' => 'Cron job not found', 'timestamp' => time()]));
}

$isTestRun = isset($_GET['test_run']) && $_GET['test_run'] == '1';

if (!$isTestRun && empty($cronJob['enabled'])) {
    http_response_code(403);
    die(json_encode(['status' => 'error', 'error' => 'Cron job is disabled', 'timestamp' => time()]));
}

if (!$isTestRun) {
    $intervalSeconds = max(1, (int) ($cronJob['interval_seconds'] ?? 60));
    $lastRun = !empty($cronJob['last_run']) ? (int) $cronJob['last_run'] : 0;
    $currentTime = time();
    if ($lastRun > 0) {
        $elapsedTime = $currentTime - $lastRun;
        if ($elapsedTime < $intervalSeconds) {
            $remainingSeconds = $intervalSeconds - $elapsedTime;
            http_response_code(429);
            die(json_encode([
                'status' => 'error',
                'error' => 'Rate limit exceeded',
                'message' => "Cron đang chạy quá nhanh. Vui lòng đợi {$remainingSeconds} giây nữa",
                'remaining_seconds' => $remainingSeconds,
                'last_run' => $lastRun,
                'interval_seconds' => $intervalSeconds,
                'timestamp' => time(),
            ]));
        }
    }
}

// Requests nobody paid expire, like the bank ones do after 20 minutes (here binance_request_ttl_minutes, 120 by default, never under 15):
// their rate and promotion were fixed when they were created, so a payment weeks later would still get the old bonus or rate. A late
// payment then shows up unmatched for an admin to settle. This runs before anything that can fail (provider missing or switched off,
// no API key, Binance unreachable), exactly like the bank sweep runs before the ACB login: an expiry that waited for a healthy
// provider left requests at "Đang xử lý" for ever, and the customer's limit of 10 open requests a day then locked them out.
if (!$isTestRun) {
    try {
        $ttlMinutes = max(15, (int) ($duogxaolin->site('binance_request_ttl_minutes') ?: 120));
        $duogxaolin->query(
            "UPDATE `recharge_binance` SET `status` = 'huy' WHERE `status` = 'xuly' AND `created_at` < ?",
            [time() - $ttlMinutes * 60]
        );
    } catch (Throwable $e) {
        log_once('binance:expire', 'binance request expiry failed: ' . $e->getMessage(), 3600);
    }
}

$providerModel = new BinanceProvider($duogxaolin);
$providerId = (int) ($cronJob['reference_id'] ?? 0);
$provider = $providerId > 0 ? $providerModel->find($providerId) : null;
if (!$provider || (int) ($provider['status'] ?? 0) !== 1) {
    http_response_code(404);
    die(json_encode(['status' => 'error', 'error' => 'Binance provider not found or inactive', 'timestamp' => time()]));
}

$config = binance_config_snapshot($provider);
$GLOBALS['binance_cron_response']['provider'] = [
    'id' => (int) ($provider['id'] ?? 0),
    'name' => (string) ($provider['name'] ?? $config['display_name']),
    'slug' => (string) ($provider['slug'] ?? $config['slug']),
];

if (trim((string) ($config['api_key'] ?? '')) === '' || trim((string) ($config['api_secret'] ?? '')) === '') {
    binance_processor_fail_provider($providerId, 'Thiếu Binance API Key hoặc API Secret cho provider này');
}

if (!$isTestRun) {
    $duogxaolin->update('cron', ['last_run' => $currentTime, 'updated_at' => $currentTime], '`id` = ?', [$cronJob['id']]);
}

try {
    $transactions = binance_processor_fetch_transactions($config, $provider);
    $GLOBALS['binance_cron_response']['fetched_count'] = count($transactions);
    binance_processor_record_provider_success($providerId);

    foreach ($transactions as $transaction) {
        binance_processor_process_transaction($transaction, $provider, $cronJob);
    }

    echo json_encode($GLOBALS['binance_cron_response'], JSON_UNESCAPED_UNICODE);
    exit;
} catch (Exception $e) {
    binance_processor_fail_provider($providerId, $e->getMessage());
}

// "Test thử" in /admin/cron is a dry run: report what would happen, write nothing
function binance_processor_is_test_run()
{
    return isset($_GET['test_run']) && $_GET['test_run'] == '1';
}

function binance_processor_fail_provider($providerId, $message)
{
    global $duogxaolin;

    $now = time();
    if ((int) $providerId > 0 && !binance_processor_is_test_run()) {
        try {
            $duogxaolin->update('binance_provider', [
                'last_history_check_at' => $now,
                'last_history_error' => (string) $message,
                'updated_at' => $now,
            ], '`id` = ?', [(int) $providerId]);
        } catch (Exception $e) {
        }
    }

    http_response_code(500);
    die(json_encode([
        'status' => 'error',
        'error' => (string) $message,
        'timestamp' => $now,
    ], JSON_UNESCAPED_UNICODE));
}

function binance_processor_record_provider_success($providerId)
{
    global $duogxaolin;

    if (binance_processor_is_test_run()) {
        return;
    }

    $now = time();
    try {
        $duogxaolin->update('binance_provider', [
            'last_history_check_at' => $now,
            'last_history_error' => null,
            'updated_at' => $now,
        ], '`id` = ?', [(int) $providerId]);
    } catch (Exception $e) {
    }
}

function binance_processor_build_signed_url($endpoint, array $params, $secret)
{
    $query = http_build_query($params, '', '&', PHP_QUERY_RFC3986);
    $signature = hash_hmac('sha256', $query, (string) $secret);
    return BINANCE_PROCESSOR_API_BASE . $endpoint . '?' . $query . '&signature=' . $signature;
}

function binance_processor_call_api($apiKey, $apiSecret, $endpoint, array $params)
{
    $url = binance_processor_build_signed_url($endpoint, $params, $apiSecret);

    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_CUSTOMREQUEST => 'GET',
        CURLOPT_HTTPHEADER => [
            'X-MBX-APIKEY: ' . $apiKey,
            'Accept: application/json',
        ],
    ]);

    $body = curl_exec($ch);
    $curlError = curl_error($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);

    if ($body === false) {
        throw new Exception($curlError !== '' ? $curlError : 'Unknown cURL error while calling Binance');
    }

    $decoded = json_decode($body, true);
    if ($httpCode < 200 || $httpCode >= 300) {
        $errorMessage = 'Binance API returned HTTP ' . $httpCode;
        if (is_array($decoded)) {
            $apiMessage = trim((string) ($decoded['msg'] ?? $decoded['message'] ?? ''));
            if ($apiMessage !== '') {
                $errorMessage .= ': ' . $apiMessage;
            }
        }
        throw new Exception($errorMessage);
    }

    if (!is_array($decoded)) {
        throw new Exception('Binance API returned invalid JSON payload');
    }

    return $decoded;
}

function binance_processor_fetch_transactions(array $config, array $provider)
{
    $startMs = (time() - (BINANCE_RECONCILIATION_LOOKBACK_DAYS * 86400)) * 1000;
    $endMs = time() * 1000;
    $params = [
        'timestamp' => (int) round(microtime(true) * 1000),
        'recvWindow' => 10000,
        'limit' => BINANCE_RECONCILIATION_FETCH_LIMIT,
        'startTime' => $startMs,
        'endTime' => $endMs,
    ];

    $decoded = binance_processor_call_api(
        (string) $config['api_key'],
        (string) $config['api_secret'],
        BINANCE_PROCESSOR_HISTORY_ENDPOINT,
        $params
    );

    if (isset($decoded['data']) && is_array($decoded['data'])) {
        return $decoded['data'];
    }

    if (isset($decoded['transactions']) && is_array($decoded['transactions'])) {
        return $decoded['transactions'];
    }

    if (array_keys($decoded) === range(0, count($decoded) - 1)) {
        return $decoded;
    }

    throw new Exception('Không thể đọc lịch sử giao dịch Binance cho provider #' . (int) ($provider['id'] ?? 0));
}

function binance_processor_extract_transaction_id(array $transaction)
{
    // Binance Pay API: transactionId is the unique identifier
    $id = $transaction['transactionId'] ?? null;
    if ($id !== null && trim((string) $id) !== '') {
        return trim((string) $id);
    }
    return '';
}

function binance_processor_extract_reference(array $transaction)
{
    // C2C transfers: user enters request_id in `note` field when sending
    // This is the primary matching reference
    return binance_first_non_empty([
        $transaction['note'] ?? null,
        $transaction['merchantTradeNo'] ?? null,
    ]);
}

function binance_processor_extract_paid_amount(array $transaction)
{
    // Binance Pay API returns `amount` directly (positive = income, negative = expenditure)
    // Also check fundsDetail for USDT breakdown
    // `amount` is in the transaction's own currency. The deposit is credited as USDT, so a payment made in
    // another asset (BNB, BTC...) must not be read as that many USDT: use only the USDT line of
    // fundsDetail for it, or nothing.
    $currency = strtoupper((string) ($transaction['currency'] ?? ''));
    $candidates = [];
    if ($currency === '' || $currency === 'USDT') {
        $candidates[] = $transaction['amount'] ?? null;
    }

    // fundsDetail may contain per-asset breakdown
    $fundsDetail = $transaction['fundsDetail'] ?? [];
    if (is_array($fundsDetail)) {
        foreach ($fundsDetail as $fund) {
            if (is_array($fund) && strtoupper((string) ($fund['currency'] ?? '')) === 'USDT') {
                $candidates[] = $fund['amount'] ?? null;
                break;
            }
        }
    }

    foreach ($candidates as $candidate) {
        if ($candidate === null || $candidate === '') {
            continue;
        }
        if (is_numeric((string) $candidate)) {
            return round(abs((float) $candidate), 8);
        }
    }

    return null;
}

function binance_processor_extract_transaction_time(array $transaction)
{
    // Binance Pay API: transactionTime in milliseconds
    $value = $transaction['transactionTime'] ?? null;

    if ($value === null || $value === '' || !is_numeric($value)) {
        return null;
    }

    $timestamp = (int) $value;
    if ($timestamp > 9999999999) {
        $timestamp = (int) floor($timestamp / 1000);
    }

    return $timestamp > 0 ? $timestamp : null;
}

function binance_processor_is_incoming(array $transaction, array $provider)
{
    // Per Binance Pay API: amount positive = income, negative = expenditure
    $amount = isset($transaction['amount']) ? (string) $transaction['amount'] : '';
    if ($amount !== '' && is_numeric($amount)) {
        return (float) $amount > 0;
    }

    // Fallback: check receiverInfo.binanceId matches provider's pay_uid
    $providerUid = trim((string) ($provider['pay_uid'] ?? ''));
    if ($providerUid !== '') {
        $receiverInfo = $transaction['receiverInfo'] ?? [];
        if (is_array($receiverInfo)) {
            $receiverBinanceId = trim((string) ($receiverInfo['binanceId'] ?? ''));
            $receiverAccountId = trim((string) ($receiverInfo['accountId'] ?? ''));
            if (($receiverBinanceId !== '' && $receiverBinanceId === $providerUid)
                || ($receiverAccountId !== '' && $receiverAccountId === $providerUid)) {
                return true;
            }
        }
    }

    return false;
}

function binance_processor_match_pending_order(array $transaction, array $provider, $bypassTransactionTimeCheck = false)
{
    global $duogxaolin;

    $bypassTransactionTimeCheck = (bool) $bypassTransactionTimeCheck;
    $providerId = (int) ($provider['id'] ?? 0);
    if ($providerId <= 0) {
        return [
            'status' => 'unmatched',
            'order' => null,
            'reason' => 'missing_provider',
            'reference' => '',
            'amount_usdt' => null,
        ];
    }

    $reference = trim((string) binance_processor_extract_reference($transaction));
    $amountUsdt = binance_processor_extract_paid_amount($transaction);
    $transactionTime = binance_processor_extract_transaction_time($transaction);

    if ($reference === '') {
        return [
            'status' => 'unmatched',
            'order' => null,
            'reason' => 'missing_reference',
            'reference' => '',
            'amount_usdt' => $amountUsdt,
        ];
    }

    $conditions = ['`provider_id` = ?', '`status` = ?', '`request_id` = ?'];
    $params = [$providerId, 'xuly', $reference];

    if ($amountUsdt === null || $amountUsdt <= 0) {
        return [
            'status' => 'unmatched',
            'order' => null,
            'reason' => 'invalid_incoming_amount',
            'reference' => $reference,
            'amount_usdt' => $amountUsdt,
            'transaction_time' => $transactionTime,
            'time_check_bypassed' => $bypassTransactionTimeCheck,
        ];
    }

    if (!$bypassTransactionTimeCheck && $transactionTime !== null) {
        $conditions[] = '`created_at` <= ?';
        $params[] = $transactionTime + 300;
    }

    $where = implode(' AND ', $conditions);
    $matches = $duogxaolin->get_list(
        "SELECT * FROM `recharge_binance` WHERE {$where} ORDER BY `created_at` ASC, `id` ASC LIMIT 2",
        $params
    );

    if (empty($matches)) {
        // Debug: check why no match — find the order by request_id alone
        $debugOrder = $duogxaolin->get_row(
            "SELECT `id`, `request_id`, `provider_id`, `status`, `usdt_amount`, `created_at`, `external_transaction_id` FROM `recharge_binance` WHERE `request_id` = ? LIMIT 1",
            [$reference]
        );

        $debugInfo = null;
        if ($debugOrder) {
            $reasons = [];
            if ((int) $debugOrder['provider_id'] !== $providerId) {
                $reasons[] = 'provider_id mismatch (order=' . $debugOrder['provider_id'] . ' cron=' . $providerId . ')';
            }
            if ((string) $debugOrder['status'] !== 'xuly') {
                $reasons[] = 'status=' . $debugOrder['status'] . ' (not xuly)';
            }
            if ($amountUsdt === null || $amountUsdt <= 0) {
                $reasons[] = 'invalid incoming amount (tx=' . ($amountUsdt === null ? 'null' : $amountUsdt) . ')';
            }
            $amountDifference = $amountUsdt !== null ? round(abs((float) $debugOrder['usdt_amount'] - $amountUsdt), 8) : null;
            if (!$bypassTransactionTimeCheck && $transactionTime !== null && (int) $debugOrder['created_at'] > ($transactionTime + 300)) {
                $reasons[] = 'order created after transaction (order_created=' . $debugOrder['created_at'] . ' tx_time=' . $transactionTime . ')';
            }
            if (!empty($debugOrder['external_transaction_id'])) {
                $reasons[] = 'already matched to tx=' . $debugOrder['external_transaction_id'];
            }
            $debugInfo = [
                'order_exists' => true,
                'order_id' => (int) $debugOrder['id'],
                'order_status' => $debugOrder['status'],
                'order_provider_id' => (int) $debugOrder['provider_id'],
                'order_usdt_amount' => (float) $debugOrder['usdt_amount'],
                'transaction_amount_usdt' => $amountUsdt,
                'amount_difference_usdt' => $amountDifference ?? null,
                'amount_matching_required' => false,
                'order_created_at' => (int) $debugOrder['created_at'],
                'transaction_time' => $transactionTime,
                'time_check_bypassed' => $bypassTransactionTimeCheck,
                'time_window_seconds' => 300,
                'reject_reasons' => $reasons,
            ];
        }

        return [
            'status' => 'unmatched',
            'order' => null,
            'reason' => 'no_pending_order',
            'reference' => $reference,
            'amount_usdt' => $amountUsdt,
            'transaction_time' => $transactionTime,
            'time_check_bypassed' => $bypassTransactionTimeCheck,
            'debug' => $debugInfo,
        ];
    }

    if (count($matches) > 1) {
        return [
            'status' => 'ambiguous',
            'order' => null,
            'reason' => 'multiple_pending_orders',
            'reference' => $reference,
            'amount_usdt' => $amountUsdt,
            'transaction_time' => $transactionTime,
            'time_check_bypassed' => $bypassTransactionTimeCheck,
            'candidate_order_ids' => array_map('intval', array_column($matches, 'id')),
            'candidate_request_ids' => array_values(array_map('strval', array_column($matches, 'request_id'))),
        ];
    }

    return [
        'status' => 'matched',
        'order' => $matches[0],
        'reason' => 'exact_request_match',
        'reference' => $reference,
        'amount_usdt' => $amountUsdt,
        'transaction_time' => $transactionTime,
        'time_check_bypassed' => $bypassTransactionTimeCheck,
    ];
}

function binance_processor_process_transaction(array $transaction, array $provider, array $cronJob)
{
    global $duogxaolin;

    if (!binance_processor_is_incoming($transaction, $provider)) {
        $transactionId = trim((string) binance_processor_extract_transaction_id($transaction));
        $rawAmount = $transaction['amount'] ?? null;
        $GLOBALS['binance_cron_response']['transactions'][] = [
            'trans_id' => $transactionId ?: null,
            'status' => 'skipped',
            'reason' => 'outgoing',
            'message' => 'Giao dịch chiều ra (amount=' . ($rawAmount ?? '?') . ')',
            'raw' => [
                'amount' => $rawAmount,
                'currency' => $transaction['currency'] ?? null,
                'note' => $transaction['note'] ?? null,
                'transactionId' => $transaction['transactionId'] ?? null,
                'transactionTime' => $transaction['transactionTime'] ?? null,
                'orderType' => $transaction['orderType'] ?? null,
                'bizType' => $transaction['bizType'] ?? null,
            ],
            'parsed' => [
                'transaction_id' => $transactionId ?: null,
                'reference' => trim((string) binance_processor_extract_reference($transaction)) ?: null,
                'amount_usdt' => binance_processor_extract_paid_amount($transaction),
                'transaction_time' => binance_processor_extract_transaction_time($transaction),
                'incoming' => false,
                'time_check_bypassed' => false,
            ],
        ];
        return;
    }

    $transactionId = trim((string) binance_processor_extract_transaction_id($transaction));
    $reference = trim((string) binance_processor_extract_reference($transaction));
    $amountUsdt = binance_processor_extract_paid_amount($transaction);
    $transactionTime = binance_processor_extract_transaction_time($transaction);
    $isTestRun = isset($_GET['test_run']) && $_GET['test_run'] == '1';
    $rawDebug = [
        'amount' => $transaction['amount'] ?? null,
        'currency' => $transaction['currency'] ?? null,
        'note' => $transaction['note'] ?? null,
        'transactionId' => $transaction['transactionId'] ?? null,
        'transactionTime' => $transaction['transactionTime'] ?? null,
        'orderType' => $transaction['orderType'] ?? null,
        'bizType' => $transaction['bizType'] ?? null,
    ];
    $parsedDebug = [
        'transaction_id' => $transactionId ?: null,
        'reference' => $reference !== '' ? $reference : null,
        'amount_usdt' => $amountUsdt,
        'transaction_time' => $transactionTime,
        'incoming' => true,
        'time_check_bypassed' => false,
    ];

    if ($transactionId === '') {
        $GLOBALS['binance_cron_response']['transactions'][] = [
            'trans_id' => null,
            'status' => 'skipped',
            'reason' => 'no_transaction_id',
            'message' => 'Bỏ qua: không xác định được transaction ID từ Binance',
            'amount' => $amountUsdt,
            'reference' => $reference ?: null,
            'raw' => $rawDebug,
            'parsed' => $parsedDebug,
        ];
        return;
    }

    $existing = $duogxaolin->get_row(
        "SELECT `id`, `request_id` FROM `recharge_binance` WHERE `external_transaction_id` = ? LIMIT 1",
        [$transactionId]
    );

    if ($existing) {
        $GLOBALS['binance_cron_response']['transactions'][] = [
            'trans_id' => $transactionId,
            'order_id' => $existing['request_id'],
            'status' => 'duplicate',
            'message' => 'Giao dịch Binance này đã được liên kết trước đó',
        ];
        return;
    }

    // the same conditions as a real run (before, the test button also ignored the time window)
    $matchResult = binance_processor_match_pending_order($transaction, $provider, false);
    if (($matchResult['status'] ?? 'unmatched') !== 'matched') {
        $reason = $matchResult['reason'] ?? 'unmatched';
        if ($reason === 'ambiguous' || ($matchResult['status'] ?? '') === 'ambiguous') {
            $GLOBALS['binance_cron_response']['errors'][] = [
                'trans_id' => $transactionId,
                'order_id' => null,
                'error' => 'Giao dịch Binance khớp nhiều đơn chờ xử lý nên bị bỏ qua để tránh cộng nhầm tiền',
                'reference' => $matchResult['reference'] ?? '',
                'candidate_order_ids' => $matchResult['candidate_order_ids'] ?? [],
                'candidate_request_ids' => $matchResult['candidate_request_ids'] ?? [],
            ];
        } elseif ($reason === 'missing_reference') {
            $GLOBALS['binance_cron_response']['errors'][] = [
                'trans_id' => $transactionId,
                'order_id' => null,
                'error' => 'Giao dịch Binance thiếu request_id/reference hợp lệ nên không được đối soát tự động',
                'reference' => $matchResult['reference'] ?? '',
                'amount_usdt' => $matchResult['amount_usdt'] ?? null,
                'raw' => $rawDebug,
                'parsed' => $parsedDebug,
                'comparison' => [
                    'provider_id' => (int) ($provider['id'] ?? 0),
                    'request_id' => $matchResult['reference'] ?? '',
                    'time_check_bypassed' => false,
                ],
            ];
        } else {
            // no_pending_order or other - log as skipped with reason + debug
            $entry = [
                'trans_id' => $transactionId,
                'status' => 'skipped',
                'reason' => $reason,
                'message' => $reason === 'no_pending_order'
                    ? 'Không tìm thấy đơn chờ xử lý khớp với giao dịch này'
                    : 'Không khớp được đơn nạp: ' . $reason,
                'reference' => $matchResult['reference'] ?? null,
                'amount_usdt' => $matchResult['amount_usdt'] ?? null,
                'transaction_time' => $matchResult['transaction_time'] ?? null,
                'raw' => $rawDebug,
                'parsed' => $parsedDebug,
                'comparison' => [
                    'provider_id' => (int) ($provider['id'] ?? 0),
                    'request_id' => $matchResult['reference'] ?? null,
                    'time_check_bypassed' => false,
                    'time_window_seconds' => 300,
                ],
            ];
            if (!empty($matchResult['debug'])) {
                $entry['debug'] = $matchResult['debug'];
            }
            $GLOBALS['binance_cron_response']['transactions'][] = $entry;
        }
        return;
    }

    $matchedOrder = $matchResult['order'];

    // dry run: say what would be credited, change nothing
    if ($isTestRun) {
        $GLOBALS['binance_cron_response']['transactions'][] = [
            'trans_id' => $transactionId,
            'status' => 'would_credit',
            'order_id' => $matchedOrder['request_id'] ?? null,
            'reference' => $matchResult['reference'] ?? null,
            'amount_usdt' => $amountUsdt,
            'message' => 'Chạy thử: giao dịch khớp đơn này, KHÔNG cộng tiền',
        ];
        return;
    }

    try {
        $duogxaolin->begin_transaction();

        $lockedOrder = $duogxaolin->get_row(
            "SELECT * FROM `recharge_binance` WHERE `id` = ? FOR UPDATE",
            [(int) $matchedOrder['id']]
        );

        if (!$lockedOrder || (string) ($lockedOrder['status'] ?? '') !== 'xuly') {
            $duogxaolin->rollback_transaction();
            return;
        }

        $providerId = (int) ($provider['id'] ?? 0);
        if ((int) ($lockedOrder['provider_id'] ?? 0) !== $providerId) {
            $duogxaolin->rollback_transaction();
            return;
        }

        $duplicateTx = $duogxaolin->get_row(
            "SELECT `id` FROM `recharge_binance` WHERE `external_transaction_id` = ? AND `id` != ? LIMIT 1",
            [$transactionId, (int) $lockedOrder['id']]
        );
        if ($duplicateTx) {
            $duogxaolin->rollback_transaction();
            return;
        }

        $user = $duogxaolin->get_row(
            "SELECT `id`, `username`, `money` FROM `users` WHERE `id` = ? LIMIT 1",
            [(int) $lockedOrder['user_id']]
        );
        if (!$user) {
            throw new Exception('Không tìm thấy người dùng cho đơn Binance #' . (int) $lockedOrder['id']);
        }

        $matchedAt = time();
        $rateUsd = (float) ($lockedOrder['rate_usd'] ?? 0);
        if ($amountUsdt === null || $amountUsdt <= 0) {
            throw new Exception('Giao dịch Binance không có số USDT incoming hợp lệ');
        }
        if ($rateUsd <= 0) {
            throw new Exception('Đơn Binance #' . (int) $lockedOrder['id'] . ' thiếu rate_usd hợp lệ để tính tiền cộng');
        }
        // the requested USDT is read here, before the update below overwrites usdt_amount with the amount really paid
        $credit = binance_credit_amounts(
            (float) $amountUsdt,
            (float) ($lockedOrder['usdt_amount'] ?? 0),
            $rateUsd,
            (float) ($lockedOrder['fees'] ?? 0),
            BINANCE_RECONCILIATION_AMOUNT_TOLERANCE
        );
        $creditedAmount = $credit['money'];
        $creditedWithPromotion = $credit['money_s'];

        $updateData = [
            'status' => 'hoantat',
            'usdt_amount' => $amountUsdt,
            'money' => $creditedAmount,
            'money_s' => $creditedWithPromotion,
            'external_transaction_id' => $transactionId,
            'external_reference' => $reference !== '' ? $reference : null,
            'matched_amount_usdt' => $amountUsdt,
            'matched_payload_json' => json_encode($transaction, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            'matched_provider_id' => $providerId,
            'matched_cron_id' => (int) ($cronJob['id'] ?? 0),
            'matched_at' => $matchedAt,
            'credited_at' => $matchedAt,
            'completed_at' => $matchedAt,
            'last_reconciliation_at' => $matchedAt,
            'last_reconciliation_error' => null,
            'reconciliation_attempts' => (int) ($lockedOrder['reconciliation_attempts'] ?? 0) + 1,
            'updated_at' => $matchedAt,
        ];

        $duogxaolin->update('recharge_binance', $updateData, '`id` = ?', [(int) $lockedOrder['id']]);

        $duogxaolin->insert('history', [
            'transaction' => $lockedOrder['request_id'],
            'start_amount' => $user['money'],
            'amount' => $creditedWithPromotion,
            'end_amount' => $user['money'] + $creditedWithPromotion,
            'time' => $matchedAt,
            'note' => 'Nạp tiền từ ' . trim((string) ($lockedOrder['display_name_snapshot'] ?? $provider['name'] ?? 'Binance')) . ' (' . format_cash($creditedWithPromotion) . ' đ) : ' . $lockedOrder['request_id'],
            'user_id' => $user['id'],
        ]);

        $duogxaolin->cong('users', 'money', $creditedWithPromotion, '`id` = ?', [$user['id']]);
        $duogxaolin->cong('users', 'total_money', $creditedWithPromotion, '`id` = ?', [$user['id']]);

        $duogxaolin->commit_transaction();

        $GLOBALS['binance_cron_response']['processed_count']++;
        $GLOBALS['binance_cron_response']['transactions'][] = [
            'trans_id' => $transactionId,
            'order_id' => $lockedOrder['request_id'],
            'user_id' => $user['id'],
            'username' => $user['username'],
            'amount' => $creditedAmount,
            'usdt_amount' => $amountUsdt,
            'rate_usd' => $rateUsd,
            'status' => 'success',
            'message' => 'Đã reconciliation và cộng tiền thành công',
        ];
    } catch (Exception $e) {
        $duogxaolin->rollback_transaction();

        $errorTime = time();
        try {
            $duogxaolin->update('recharge_binance', [
                'reconciliation_attempts' => (int) ($matchedOrder['reconciliation_attempts'] ?? 0) + 1,
                'last_reconciliation_at' => $errorTime,
                'last_reconciliation_error' => $e->getMessage(),
                'updated_at' => $errorTime,
            ], '`id` = ?', [(int) $matchedOrder['id']]);
        } catch (Exception $inner) {
        }

        $GLOBALS['binance_cron_response']['errors'][] = [
            'trans_id' => $transactionId,
            'order_id' => $matchedOrder['request_id'] ?? null,
            'error' => $e->getMessage(),
        ];
    }
}
