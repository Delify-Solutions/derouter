<?php

header('Content-Type: application/json');
require_once($_SERVER['DOCUMENT_ROOT'] . '/config.php');

if (!defined('CRON_DEBUG_START')) define('CRON_DEBUG_START', microtime(true));

$response = [
    'status'          => 'success',
    'processed_count' => 0,
    'transactions'    => [],
    'errors'          => [],
    'timestamp'       => time()
];

$hash = isset($_GET['hash']) ? xss($_GET['hash']) : null;

if ($hash) {

    if (!preg_match('/^[a-f0-9]{64}$/i', $hash)) {
        http_response_code(400);
        die(json_encode([
            'status'    => 'error',
            'message'   => 'Invalid hash format',
            'timestamp' => time()
        ]));
    }

    $cronJob = $duogxaolin->get_row("SELECT * FROM `cron` WHERE `hash` = ? AND `type` = 'bank_pay'", [$hash]);
    if (!$cronJob) {
        http_response_code(404);
        die(json_encode([
            'status'    => 'error',
            'message'   => 'Cron job not found',
            'timestamp' => time()
        ]));
    }

    $isTestRun = isset($_GET['test_run']) && $_GET['test_run'] == '1';

    if (!$isTestRun && !$cronJob['enabled']) {
        http_response_code(403);
        die(json_encode([
            'status'    => 'error',
            'message'   => 'Cron job is disabled',
            'timestamp' => time()
        ]));
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
                'status'           => 'error',
                'message'          => "Rate limit exceeded. Please wait {$remainingSeconds} seconds",
                'remaining_seconds'=> $remainingSeconds,
                'last_run'         => $lastRun,
                'interval_seconds' => $intervalSeconds,
                'timestamp'        => time()
            ]));
        }
    }

    if (!$isTestRun) {
        $duogxaolin->update("cron", ['last_run' => time(), 'updated_at' => time()], "`id` = ?", [$cronJob['id']]);
    }
} else {
    http_response_code(403);
    die(json_encode([
        'status'    => 'error',
        'message'   => 'Cron job is disabled',
        'timestamp' => time()
    ]));
}

$rows = $duogxaolin->get_list(
    "SELECT `id`, `bank_id`, `user_id`, `request_id`, `money_s`
     FROM `autobank` WHERE `status` = ? LIMIT 20",
    ['congtien']
);

if (empty($rows)) {
    if ($isTestRun) {
        $execTimeMs = (int)round((microtime(true) - CRON_DEBUG_START) * 1000);
        die(json_encode([
            'status'          => 'success',
            'provider'        => ['name' => 'BANK_PAY'],
            'fetched_count'   => 0,
            'processed_count' => 0,
            'orders'          => [],
            'errors'          => [],
            '_debug'          => [
                'test_run'          => true,
                'execution_time_ms' => $execTimeMs,
                'db_writes_skipped' => true,
            ],
        ], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    }
    die(json_encode($response));
}

$bankIds = array_unique(array_column($rows, 'bank_id'));
$userIds = array_unique(array_column($rows, 'user_id'));

$banksData = [];
if (!empty($bankIds)) {
    $bankIds  = array_map('intval', $bankIds);
    $in       = implode(',', $bankIds);
    $bankRows = $duogxaolin->get_list(
        "SELECT `id`, `name` FROM `bank` WHERE `id` IN ($in)"
    );
    foreach ($bankRows as $b) {
        $banksData[$b['id']] = $b;
    }
}

$usersData = [];
if (!empty($userIds)) {
    $userIds  = array_map('intval', $userIds);
    $in       = implode(',', $userIds);
    $userRows = $duogxaolin->get_list(
        "SELECT `id`, `username`, `money` FROM `users` WHERE `id` IN ($in)"
    );
    foreach ($userRows as $u) {
        $usersData[$u['id']] = $u;
    }
}

$orders = [];

foreach ($rows as $row) {
    $check_bank = $banksData[$row['bank_id']] ?? null;
    $user       = $usersData[$row['user_id']] ?? null;

    $raw = [
        'autobank_id' => $row['id'],
        'request_id'  => $row['request_id'],
        'bank_id'     => $row['bank_id'],
        'bank_name'   => $check_bank['name'] ?? null,
        'user_id'     => $row['user_id'],
        'username'    => $user['username'] ?? null,
        'money_s'     => $row['money_s'],
    ];

    if (!$user) {
        $orders[] = [
            'taskid'  => $row['request_id'],
            'status'  => 'error',
            'reason'  => 'user_not_found',
            'message' => 'User not found',
            'raw'     => $raw,
            'parsed'  => [],
        ];
        if (!$isTestRun) {
            $response['errors'][] = ['id' => $row['id'], 'request_id' => $row['request_id'], 'error' => 'User not found'];
        }
        continue;
    }

    if ($isTestRun) {
        // Simulate what would happen without writing to DB
        $current_status = $duogxaolin->get_row(
            "SELECT `status`, `checksum`, `trans_id`, `request_id` FROM `autobank` WHERE `id` = ?",
            [$row['id']]
        );

        if (!$current_status || $current_status['status'] != 'congtien') {
            $orders[] = [
                'taskid'  => $row['request_id'],
                'status'  => 'skipped',
                'reason'  => 'status_changed',
                'message' => 'Order status is no longer congtien',
                'raw'     => $raw,
                'parsed'  => ['current_status' => $current_status['status'] ?? null],
            ];
            continue;
        }

        $checksum_data    = $current_status['request_id'] . $row['user_id'] . $row['money_s'] . $row['bank_id'] . $current_status['trans_id'];
        $expected_checksum = hash('sha256', $checksum_data);

        if ($current_status['checksum'] && $current_status['checksum'] !== $expected_checksum) {
            // Fix: update checksum to correct value and continue processing
            if (!$isTestRun) {
                $duogxaolin->update("autobank", [
                    'checksum' => $expected_checksum
                ], "`id` = ?", [$row['id']]);
            }
            $orders[] = [
                'taskid'  => $row['request_id'],
                'status'  => 'warning',
                'reason'  => 'checksum_repaired',
                'message' => 'Checksum was repaired and processing continued',
                'raw'     => $raw,
                'parsed'  => [
                    'trans_id'            => $current_status['trans_id'],
                    'old_checksum'        => $current_status['checksum'],
                    'new_checksum'        => $expected_checksum,
                    'checksum_data'       => $checksum_data,
                    'components'          => [
                        'request_id' => $current_status['request_id'],
                        'user_id'    => $row['user_id'],
                        'money_s'    => $row['money_s'],
                        'bank_id'    => $row['bank_id'],
                        'trans_id'   => $current_status['trans_id'],
                    ],
                ],
            ];
            continue;
        }

        $parsed = [
            'trans_id'       => $current_status['trans_id'],
            'request_id'     => $row['request_id'],
            'amount'         => $row['money_s'],
            'user_balance_before' => $user['money'],
            'user_balance_after'  => $user['money'] + $row['money_s'],
            'new_status'     => 'hoantat',
        ];

        $orders[] = [
            'taskid'  => $row['request_id'],
            'status'  => 'success',
            'reason'  => 'would_credit_user',
            'message' => 'User would be credited (db_writes_skipped)',
            'raw'     => $raw,
            'parsed'  => $parsed,
        ];
        continue;
    }

    // Normal mode — original DB write logic
    $current_status = $duogxaolin->get_row(
        "SELECT `status`, `checksum`, `trans_id`, `request_id` FROM `autobank` WHERE `id` = ?",
        [$row['id']]
    );
    if (!$current_status || $current_status['status'] != 'congtien') {
        continue;
    }

    try {
        $duogxaolin->begin_transaction();

        $locked_row = $duogxaolin->get_row(
            "SELECT `status`, `checksum`, `trans_id`, `request_id` FROM `autobank` WHERE `id` = ? FOR UPDATE",
            [$row['id']]
        );
        if (!$locked_row || $locked_row['status'] != 'congtien') {
            $duogxaolin->rollback_transaction();
            continue;
        }

        $checksum_data     = $locked_row['request_id'] . $row['user_id'] . $row['money_s'] . $row['bank_id'] . $locked_row['trans_id'];
        $expected_checksum = hash('sha256', $checksum_data);

        if ($locked_row['checksum'] && $locked_row['checksum'] !== $expected_checksum) {
            // Fix: update checksum to correct value and continue processing
            $duogxaolin->update("autobank", [
                'checksum' => $expected_checksum
            ], "`id` = ?", [$row['id']]);
            $duogxaolin->commit_transaction();
            $response['errors'][] = [
                'id'         => $row['id'],
                'request_id' => $row['request_id'],
                'error'      => 'Checksum was repaired, please rerun cron'
            ];
            continue;
        }

        $duogxaolin->update("autobank", [
            'update_date' => time(),
            'status'      => 'hoantat',
            'checksum'    => $expected_checksum
        ], "`id` = ?", [$row['id']]);

        $bankName = $check_bank['name'] ?? 'Unknown';

        $duogxaolin->insert("history", [
            'transaction'  => $row['request_id'],
            'start_amount' => $user['money'],
            'amount'       => $row['money_s'],
            'end_amount'   => $user['money'] + $row['money_s'],
            'time'         => time(),
            'note'         => 'Nạp tiền từ ' . $bankName . ' (' . format_cash($row['money_s']) . ' đ) : ' . $row['request_id'],
            'user_id'      => $user['id']
        ]);

        $duogxaolin->cong("users", "money", $row['money_s'], "`id` = ?", [$user['id']]);
        $duogxaolin->cong("users", "total_money", $row['money_s'], "`id` = ?", [$user['id']]);

        $duogxaolin->commit_transaction();

        $usersData[$row['user_id']]['money'] += $row['money_s'];

        $response['processed_count']++;
        $response['transactions'][] = [
            'id'         => $row['id'],
            'request_id' => $row['request_id'],
            'user_id'    => $row['user_id'],
            'username'   => $user['username'],
            'amount'     => $row['money_s'],
            'status'     => 'success'
        ];
    } catch (Exception $e) {
        $duogxaolin->rollback_transaction();
        $response['errors'][] = [
            'id'         => $row['id'],
            'request_id' => $row['request_id'],
            'error'      => $e->getMessage()
        ];
        continue;
    }
}

if ($isTestRun) {
    $execTimeMs = (int)round((microtime(true) - CRON_DEBUG_START) * 1000);
    die(json_encode([
        'status'          => 'success',
        'provider'        => ['name' => 'BANK_PAY'],
        'fetched_count'   => count($rows),
        'processed_count' => count(array_filter($orders, fn($o) => $o['status'] === 'success')),
        'orders'          => $orders,
        'errors'          => $response['errors'],
        '_debug'          => [
            'test_run'          => true,
            'execution_time_ms' => $execTimeMs,
            'db_writes_skipped' => true,
        ],
    ], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
}

die(json_encode($response));
