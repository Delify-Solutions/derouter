<?php

header('Content-Type: application/json; charset=utf-8');

if (!defined('CRON_DEBUG_START')) define('CRON_DEBUG_START', microtime(true));

$GLOBALS['cron_response'] = [
    'status'          => 'success',
    'bank'            => null,
    'processed_count' => 0,
    'transactions'    => [],
    'errors'          => [],
    'timestamp'       => time()
];

require_once $_SERVER["DOCUMENT_ROOT"] . "/config.php";

$hash = isset($_GET['hash']) ? trim($_GET['hash']) : '';

if (empty($hash)) {
    http_response_code(400);
    die(json_encode(['status' => 'error', 'error' => 'Missing bank hash parameter', 'timestamp' => time()]));
}

if (!preg_match('/^[a-f0-9]{64}$/i', $hash)) {
    http_response_code(400);
    die(json_encode(['status' => 'error', 'error' => 'Invalid hash format', 'timestamp' => time()]));
}

$cronJob = $duogxaolin->get_row(
    "SELECT * FROM `cron` WHERE `hash` = ? AND `type` = 'bank_payment'",
    [$hash]
);

if (!$cronJob) {
    http_response_code(404);
    die(json_encode(['status' => 'error', 'error' => 'Cron job not found', 'timestamp' => time()]));
}

$isTestRun = isset($_GET['test_run']) && $_GET['test_run'] == '1';

if (!$isTestRun && !$cronJob['enabled']) {
    http_response_code(403);
    die(json_encode(['status' => 'error', 'error' => 'Cron job is disabled', 'timestamp' => time()]));
}

if (!$isTestRun && $cronJob['last_run']) {
    $currentTime     = time();
    $lastRun         = (int)$cronJob['last_run'];
    $intervalSeconds = (int)$cronJob['interval_seconds'];
    $elapsedTime     = $currentTime - $lastRun;

    if ($elapsedTime < $intervalSeconds) {
        $remainingSeconds = $intervalSeconds - $elapsedTime;
        http_response_code(429);
        die(json_encode([
            'status'            => 'error',
            'error'             => 'Rate limit exceeded',
            'message'           => "Cron đang chạy quá nhanh. Vui lòng đợi {$remainingSeconds} giây nữa",
            'remaining_seconds' => $remainingSeconds,
            'last_run'          => $lastRun,
            'interval_seconds'  => $intervalSeconds,
            'timestamp'         => time()
        ]));
    }
}

$bank = $duogxaolin->get_row(
    "SELECT b.*, n.short_name, n.code as nganhang_code, n.api, n.type as api_type, n.source
     FROM `bank` b
     LEFT JOIN `nganhang` n ON b.code = n.id
     WHERE b.id = ? AND b.type = 'bank' AND b.password IS NOT NULL",
    [$cronJob['reference_id']]
);

if (!$bank) {
    http_response_code(404);
    die(json_encode(['status' => 'error', 'error' => 'Bank not found or inactive', 'timestamp' => time()]));
}

$GLOBALS['cron_response']['bank'] = $bank['name'] . ' - ' . ($bank['short_name'] ?? $bank['code_name']);

// Maintenance mode check: bank must be active (status == 1), bypassed by test_run
if (!$isTestRun && isset($bank['status']) && (int)$bank['status'] !== 1) {
    http_response_code(503);
    die(json_encode(['success' => false, 'error' => 'Bank is currently in maintenance mode']));
}

if (!$isTestRun) {
    $duogxaolin->update("cron", ["last_run" => time(), "updated_at" => time()], "`id` = ?", [$cronJob['id']]);

    // Expire deposit requests nobody paid within 20 minutes. This used to run on every page view
    // (app/controllers/is_username.php) and fought with this cron's row locks.
    try {
        $duogxaolin->query(
            "UPDATE `autobank` SET `status` = 'huy' WHERE `status` = 'xuly' AND (UNIX_TIMESTAMP() - `update_date`) > 1200"
        );
    } catch (Exception $e) {
        // Not worth failing the whole bank check; it runs again on the next tick.
        log_once('bank:expiry', "autobank expiry sweep failed: " . $e->getMessage(), 600);
    }
}

$noiDungNap = $duogxaolin->site("noi_dung_nap");

$nganhangData = [
    'short_name' => $bank['short_name'],
    'api'        => $bank['api'],
    'type'       => $bank['api_type'],
    'source'     => $bank['source']
];

if ($bank['source'] === 'local') {
    processLocalBank($bank, $nganhangData, $noiDungNap, $isTestRun);
} else {
    processWeb2mBank($bank, $nganhangData, $noiDungNap, $isTestRun);
}

if ($isTestRun) {
    $execTimeMs   = (int)round((microtime(true) - CRON_DEBUG_START) * 1000);
    $transactions = $GLOBALS['cron_response']['transactions'] ?? [];
    $orders       = [];
    foreach ($transactions as $tx) {
        $orders[] = [
            'taskid'  => $tx['trans_id'] ?? null,
            'status'  => $tx['status'] ?? 'unknown',
            'reason'  => $tx['reason'] ?? $tx['status'] ?? 'unknown',
            'raw'     => $tx['raw'] ?? [],
            'parsed'  => $tx['parsed'] ?? [],
            'message' => $tx['message'] ?? null,
        ];
    }
    die(json_encode([
        'status'          => 'success',
        'provider'        => ['name' => 'BANK_' . strtoupper($bank['short_name'] ?? $bank['name'])],
        'fetched_count'   => count($transactions),
        'processed_count' => $GLOBALS['cron_response']['processed_count'],
        'orders'          => $orders,
        'errors'          => $GLOBALS['cron_response']['errors'],
        '_debug'          => [
            'test_run'          => true,
            'execution_time_ms' => $execTimeMs,
            'db_writes_skipped' => true,
        ],
    ], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
}

echo json_encode($GLOBALS['cron_response'], JSON_UNESCAPED_UNICODE);
exit;

function processWeb2mBank($bank, $nganhangData, $noiDungNap, $isTestRun = false) {
    global $duogxaolin;

    $decryptedPassword = decryptBankPassword($bank["password"]);

    $token = $bank["atm_token"];
    if (empty($token)) {
        $GLOBALS['cron_response']['status']   = 'error';
        $GLOBALS['cron_response']['errors'][] = "Missing ATM token for bank {$bank['name']}";
        return;
    }

    $transactions = fetchWeb2mTransactions($bank, $nganhangData, $decryptedPassword);

    if ($transactions === null) {
        $GLOBALS['cron_response']['status']   = 'error';
        $GLOBALS['cron_response']['errors'][] = "Failed to fetch transactions for bank {$bank['name']}";
        return;
    }

    foreach ($transactions as $data) {
        if ($data["type"] != "IN") {
            continue;
        }

        $transactionData = [
            'trans_id' => str_replace(" ", "", $data["transactionID"]),
            'comment'  => $data["description"],
            'amount'   => $data["amount"],
            'raw'      => $data,
        ];

        processTransaction($transactionData, $bank, $noiDungNap, $isTestRun);
    }
}

function processLocalBank($bank, $nganhangData, $noiDungNap, $isTestRun = false) {
    global $duogxaolin;

    $decryptedPassword = decryptBankPassword($bank["password"]);

    $username = $bank["api_username"];
    $stk      = $bank["stk"];

    if (empty($username) || empty($decryptedPassword) || empty($stk)) {
        $GLOBALS['cron_response']['status']   = 'error';
        $GLOBALS['cron_response']['errors'][] = "Missing credentials for bank {$bank['name']}";
        return;
    }

    $transactions = fetchACBTransactions($bank, $username, $decryptedPassword, $stk);

    if ($transactions === null) {
        $GLOBALS['cron_response']['status']   = 'error';
        $GLOBALS['cron_response']['errors'][] = "Failed to fetch transactions for bank {$bank['name']}"
            . (!empty($GLOBALS['acb_last_error']) ? ': ' . $GLOBALS['acb_last_error'] : '');
        return;
    }

    foreach ($transactions as $data) {
        if ($data["type"] != "IN") {
            continue;
        }

        $transactionData = [
            'trans_id' => $data["transactionNumber"],
            'comment'  => $data["description"],
            'amount'   => $data["amount"],
            'raw'      => $data,
        ];

        processTransaction($transactionData, $bank, $noiDungNap, $isTestRun);
    }
}

function fetchWeb2mTransactions($bank, $nganhangData, $decryptedPassword) {
    $token = $bank["atm_token"];
    $stk   = $bank["stk"];

    if ($nganhangData["type"] == 1) {
        $urlapibank = $nganhangData["api"] . "/" . $token;
    } else {
        $urlapibank = $nganhangData["api"] . "/" . $decryptedPassword . "/" . $stk . "/" . $token;
    }

    $curl = curl_init();
    curl_setopt_array($curl, [
        CURLOPT_URL            => $urlapibank,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_ENCODING       => "",
        CURLOPT_MAXREDIRS      => 10,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_HTTP_VERSION   => CURL_HTTP_VERSION_1_1,
        CURLOPT_CUSTOMREQUEST  => "GET",
    ]);
    $response = curl_exec($curl);

    $result = json_decode($response, true);
    if (!$result || !isset($result["transactions"])) {
        return null;
    }

    return $result["transactions"];
}

function fetchACBTransactions($bank, $username, $password, $stk) {
    try {
        require_once __DIR__ . "/acb-lib.php";

        // Token is cached between cron runs and renewed once if it expired.
        $acb          = new ACB($username, $password);
        $transactions = $acb->transactions($stk, 100);

        if ($transactions === null) {
            $GLOBALS['acb_last_error'] = $acb->lastError;
            log_once('bank:acb:' . ($bank['name'] ?? '?'), "ACB API Error ({$bank['name']}): " . $acb->lastError, 600);
            return null;
        }

        return $transactions;
    } catch (Exception $e) {
        $GLOBALS['acb_last_error'] = $e->getMessage();
        log_once('bank:acb:exception', "ACB API Error: " . $e->getMessage(), 600);
        return null;
    }
}


/**
 * A transfer that matches a deposit request by its code but cannot be credited by the cron (the request already expired, or the amount
 * differs) used to be dropped without a trace: the customer had paid, nobody was told. Write what happened into the request's comment,
 * which /admin/recharge/list shows, so an admin can check the bank and credit it by hand. Idempotent: the cron fetches the same
 * transfer on every run, and a note is added once per transaction id. The row's status and trans_id are not touched (a trans_id
 * would stop an admin from re-opening the request, see DepositStatusRules).
 */
function bank_note_unmatched_transfer(string $requestId, string $transactionId, $amount, string $reason): void
{
    global $duogxaolin;
    if ($requestId === '' || $transactionId === '') {
        return;
    }
    try {
        $note = '[CẦN KIỂM TRA] ' . $reason . ' - mã giao dịch ' . $transactionId . ', ' . $amount . ' đ, phát hiện lúc ' . date('H:i d/m/Y');
        $duogxaolin->query(
            "UPDATE `autobank` SET `comment` = ? WHERE `request_id` = ? AND `status` IN ('xuly', 'huy', 'loi') AND (`comment` IS NULL OR `comment` NOT LIKE ?)",
            [$note, $requestId, '%' . $transactionId . '%']
        );
        log_once('bank:unmatched:' . $transactionId, 'bank: transfer ' . $transactionId . ' (' . $amount . ') for request ' . $requestId . ' not credited: ' . $reason, 86400);
    } catch (Throwable $e) {
        // a note is a courtesy: never let it break the cron
    }
}

function processTransaction($transactionData, $bank, $noiDungNap, $isTestRun = false) {
    global $duogxaolin;

    $magd    = $transactionData['trans_id'];
    $comment = $transactionData['comment'];
    $amount  = $transactionData['amount'];
    $rawData = $transactionData['raw'] ?? [];

    $id = parse_order_id($comment);
    $id = $noiDungNap . $id;

    if ($id == null) {
        if ($isTestRun) {
            $GLOBALS['cron_response']['transactions'][] = [
                'trans_id' => $magd,
                'order_id' => null,
                'status'   => 'skipped',
                'reason'   => 'no_order_id_in_comment',
                'message'  => 'Could not parse order ID from comment',
                'raw'      => $rawData,
                'parsed'   => ['comment' => $comment, 'amount' => $amount],
            ];
        }
        return;
    }

    if ($isTestRun) {
        // In test mode: check if the order exists and what would happen, but skip DB writes
        $check_his = $duogxaolin->get_row(
            "SELECT `id`, `user_id`, `money`, `money_s`, `checksum`, `processing_lock`
             FROM `autobank`
             WHERE `request_id` = ? AND `status` = 'xuly'",
            [$id]
        );

        $parsed = [
            'trans_id'  => $magd,
            'order_id'  => $id,
            'amount'    => $amount,
            'comment'   => $comment,
        ];

        if (!$check_his) {
            $GLOBALS['cron_response']['transactions'][] = [
                'trans_id' => $magd,
                'order_id' => $id,
                'status'   => 'skipped',
                'reason'   => 'order_not_found',
                'message'  => 'No pending autobank order found for this request_id',
                'raw'      => $rawData,
                'parsed'   => $parsed,
            ];
            return;
        }

        if ($check_his["processing_lock"] && time() - $check_his["processing_lock"] <= 300) {
            $GLOBALS['cron_response']['transactions'][] = [
                'trans_id' => $magd,
                'order_id' => $id,
                'status'   => 'being_processed',
                'reason'   => 'processing_lock',
                'message'  => 'Transaction is currently being processed by another request',
                'raw'      => $rawData,
                'parsed'   => array_merge($parsed, ['lock_age' => time() - $check_his["processing_lock"]]),
            ];
            return;
        }

        if ($amount != $check_his["money"]) {
            $GLOBALS['cron_response']['transactions'][] = [
                'trans_id' => $magd,
                'order_id' => $id,
                'status'   => 'error',
                'reason'   => 'amount_mismatch',
                'message'  => 'Amount mismatch',
                'raw'      => $rawData,
                'parsed'   => array_merge($parsed, [
                    'expected_amount' => $check_his["money"],
                    'received_amount' => $amount,
                ]),
            ];
            return;
        }

        $existing_trans = $duogxaolin->get_row(
            "SELECT `id` FROM `autobank` WHERE `trans_id` = ? AND `id` != ?",
            [$magd, $check_his["id"]]
        );
        if ($existing_trans) {
            $GLOBALS['cron_response']['transactions'][] = [
                'trans_id' => $magd,
                'order_id' => $id,
                'status'   => 'error',
                'reason'   => 'duplicate_trans_id',
                'message'  => 'Transaction ID already exists',
                'raw'      => $rawData,
                'parsed'   => $parsed,
            ];
            return;
        }

        $checksum_data = $id . $check_his["user_id"] . $check_his["money_s"] . $bank["id"] . $magd;
        $new_checksum  = hash("sha256", $checksum_data);
        if ($check_his["checksum"] && $check_his["checksum"] !== $new_checksum) {
            $GLOBALS['cron_response']['transactions'][] = [
                'trans_id' => $magd,
                'order_id' => $id,
                'status'   => 'error',
                'reason'   => 'checksum_mismatch',
                'message'  => 'Checksum mismatch — possible replay or data corruption',
                'raw'      => $rawData,
                'parsed'   => $parsed,
            ];
            return;
        }

        // Would succeed
        $GLOBALS['cron_response']['processed_count']++;
        $GLOBALS['cron_response']['transactions'][] = [
            'trans_id' => $magd,
            'order_id' => $id,
            'status'   => 'success',
            'reason'   => 'would_process',
            'message'  => 'Transaction would be processed successfully (db_writes_skipped)',
            'raw'      => $rawData,
            'parsed'   => array_merge($parsed, [
                'autobank_id' => $check_his["id"],
                'user_id'     => $check_his["user_id"],
                'new_status'  => 'congtien',
            ]),
        ];
        return;
    }

    // Normal (non-test) mode — original logic with DB writes
    try {
        $duogxaolin->begin_transaction();

        $check_his = $duogxaolin->get_row(
            "SELECT `id`, `user_id`, `money`, `money_s`, `checksum`, `processing_lock`
             FROM `autobank`
             WHERE `request_id` = ? AND `status` = 'xuly'
             FOR UPDATE",
            [$id]
        );

        if (!$check_his) {
            $duogxaolin->rollback_transaction();
            bank_note_unmatched_transfer((string) $id, (string) $magd, $amount, 'Chuyển khoản đến khi yêu cầu nạp đã hết hạn (quá 20 phút) hoặc đã xử lý, chưa được cộng tiền');
            return;
        }

        if ($check_his["processing_lock"] && time() - $check_his["processing_lock"] > 300) {
            $duogxaolin->update(
                "autobank",
                ["processing_lock" => null],
                "`id` = ?",
                [$check_his["id"]]
            );
        }

        if ($check_his["processing_lock"] && time() - $check_his["processing_lock"] <= 300) {
            $duogxaolin->rollback_transaction();
            $GLOBALS['cron_response']['transactions'][] = [
                'trans_id' => $magd,
                'order_id' => $id,
                'status'   => 'being_processed',
                'message'  => 'Transaction is currently being processed by another request'
            ];
            return;
        }

        $user = $duogxaolin->get_row(
            "SELECT `id` FROM `users` WHERE `id` = ?",
            [$check_his["user_id"]]
        );

        if (!$user) {
            $duogxaolin->rollback_transaction();
            $GLOBALS['cron_response']['transactions'][] = [
                'trans_id' => $magd,
                'order_id' => $id,
                'status'   => 'error',
                'message'  => 'User not found'
            ];
            return;
        }

        if ($amount == $check_his["money"]) {

            $existing_trans = $duogxaolin->get_row(
                "SELECT `id` FROM `autobank` WHERE `trans_id` = ? AND `id` != ?",
                [$magd, $check_his["id"]]
            );

            if ($existing_trans) {
                $duogxaolin->rollback_transaction();
                $GLOBALS['cron_response']['transactions'][] = [
                    'trans_id' => $magd,
                    'order_id' => $id,
                    'status'   => 'error',
                    'message'  => 'Transaction ID already exists'
                ];
                return;
            }

            $checksum_data = $id . $check_his["user_id"] . $check_his["money_s"] . $bank["id"] . $magd;
            $new_checksum  = hash("sha256", $checksum_data);

            if ($check_his["checksum"] && $check_his["checksum"] !== $new_checksum) {
                $duogxaolin->rollback_transaction();
                $GLOBALS['cron_response']['transactions'][] = [
                    'trans_id' => $magd,
                    'order_id' => $id,
                    'status'   => 'error',
                    'message'  => 'Checksum mismatch'
                ];
                return;
            }

            $duogxaolin->update(
                "autobank",
                ["processing_lock" => time()],
                "`id` = ?",
                [$check_his["id"]]
            );

            $duogxaolin->update(
                "autobank",
                [
                    "trans_id"        => $magd,
                    "comment"         => $comment,
                    "update_date"     => time(),
                    "status"          => "congtien",
                    "checksum"        => $new_checksum,
                    "processing_lock" => null,
                ],
                "`id` = ?",
                [$check_his["id"]]
            );

            $duogxaolin->commit_transaction();

            $GLOBALS['cron_response']['processed_count']++;
            $GLOBALS['cron_response']['transactions'][] = [
                'trans_id' => $magd,
                'order_id' => $id,
                'amount'   => $amount,
                'status'   => 'success',
                'message'  => 'Transaction processed successfully'
            ];
        } else {
            $duogxaolin->rollback_transaction();
            bank_note_unmatched_transfer((string) $id, (string) $magd, $amount, 'Số tiền chuyển khác số tiền yêu cầu (yêu cầu ' . $check_his["money"] . ' đ), chưa được cộng tiền');
            $GLOBALS['cron_response']['transactions'][] = [
                'trans_id'       => $magd,
                'order_id'       => $id,
                'expected_amount'=> $check_his["money"],
                'received_amount'=> $amount,
                'status'         => 'error',
                'message'        => 'Amount mismatch'
            ];
        }
    } catch (Exception $e) {
        $duogxaolin->rollback_transaction();
        $GLOBALS['cron_response']['transactions'][] = [
            'trans_id' => $magd,
            'order_id' => $id,
            'status'   => 'error',
            'message'  => 'Exception: ' . $e->getMessage()
        ];
        return;
    }
}
