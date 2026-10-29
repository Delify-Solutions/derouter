<?php

require_once $_SERVER['DOCUMENT_ROOT'] . '/app/models/BinanceProvider.php';

function binance_option_value($key, $default = '')
{
    global $duogxaolin;

    $value = $duogxaolin->site($key);
    if ($value === null || $value === '') {
        return $default;
    }

    return $value;
}

function binance_provider_model(): BinanceProvider
{
    global $duogxaolin;

    static $model = null;
    if ($model === null) {
        $model = new BinanceProvider($duogxaolin);
    }

    return $model;
}

function binance_provider_default_name()
{
    return 'Binance USDT';
}

function binance_provider_default_slug()
{
    return 'binance-usdt';
}

function normalize_binance_provider_slug($slug)
{
    global $duogxaolin;

    $normalized = $duogxaolin->to_slug((string) $slug);
    return $normalized !== '' ? $normalized : binance_provider_default_slug();
}

function binance_provider_row_to_snapshot(array $provider)
{
    $apiKey = trim((string) ($provider['api_key'] ?? ''));
    $apiSecret = trim((string) ($provider['api_secret'] ?? ''));

    return [
        'provider_id' => isset($provider['id']) ? (int) $provider['id'] : null,
        'display_name' => trim((string) ($provider['name'] ?? '')) ?: binance_provider_default_name(),
        'slug' => normalize_binance_provider_slug($provider['slug'] ?? ''),
        'status' => isset($provider['status']) ? (int) $provider['status'] : 0,
        'note' => (string) ($provider['note'] ?? ''),
        'provider_note' => (string) ($provider['note'] ?? ''),
        'pay_uid' => (string) ($provider['pay_uid'] ?? ''),
        'account_name' => (string) ($provider['account_name'] ?? ''),
        'qr_image_id' => !empty($provider['qr_image_id']) ? (int) $provider['qr_image_id'] : null,
        'qr_image_path' => (string) ($provider['qr_image_path'] ?? ''),
        'instructions' => (string) ($provider['instructions'] ?? ''),
        'min_usdt' => max(0, (float) ($provider['min_usdt'] ?? 1)),
        'api_key' => $apiKey,
        'api_secret' => $apiSecret,
        'api_key_hash' => ($apiKey !== '' || $apiSecret !== '') ? hash('sha256', $apiKey . '|' . $apiSecret) : null,
        'is_legacy_migrated' => !empty($provider['is_legacy_migrated']) ? 1 : 0,
    ];
}

function binance_all_providers($enabledOnly = false)
{
    try {
        return $enabledOnly ? binance_provider_model()->enabled() : binance_provider_model()->all(true);
    } catch (Exception $e) {
        return [];
    }
}

function get_binance_provider_by_slug($slug, $enabledOnly = false)
{
    $slug = normalize_binance_provider_slug($slug);
    if ($slug === '') {
        return null;
    }

    try {
        return binance_provider_model()->findBySlug($slug, (bool) $enabledOnly);
    } catch (Exception $e) {
        return null;
    }
}

function binance_enabled()
{
    return count(binance_all_providers(true)) > 0;
}

function binance_rate_usd()
{
    $rate = (float) binance_option_value('rate_usd', 0);
    return $rate > 0 ? $rate : 1;
}

/**
 * What a matched Binance payment credits. The promotion percent (`fees` of the request) was fixed when the request was created, and
 * whether the request qualified for it was judged on the USDT REQUESTED. So the bonus only applies when at least that much was really
 * paid: otherwise a customer could request a big amount, pay 1 USDT and still get the bonus. An underpayment is still credited at the
 * amount actually paid, just without the bonus.
 *
 * @return array{money: float, money_s: float, bonus_applied: bool}
 */
function binance_credit_amounts(float $paidUsdt, float $requestedUsdt, float $rateUsd, float $bonusPercent, float $tolerance = 0.00000001): array
{
    $money = round($paidUsdt * $rateUsd, 2);
    $bonusApplied = $bonusPercent > 0 && $requestedUsdt > 0 && $paidUsdt + $tolerance >= $requestedUsdt;
    $withBonus = $bonusApplied ? round($money + ($money * $bonusPercent / 100), 2) : $money;
    return ['money' => $money, 'money_s' => $withBonus, 'bonus_applied' => $bonusApplied];
}

function binance_empty_config_snapshot()
{
    return [
        'provider_id' => null,
        'display_name' => binance_provider_default_name(),
        'slug' => binance_provider_default_slug(),
        'status' => 0,
        'note' => '',
        'provider_note' => '',
        'pay_uid' => '',
        'account_name' => '',
        'qr_image_id' => null,
        'qr_image_path' => '',
        'instructions' => '',
        'min_usdt' => 1,
        'api_key' => '',
        'api_secret' => '',
        'api_key_hash' => null,
        'is_legacy_migrated' => 0,
    ];
}

function binance_display_name()
{
    return binance_provider_default_name();
}

function binance_config_snapshot($provider = null)
{
    if (is_array($provider) && !empty($provider)) {
        return binance_provider_row_to_snapshot($provider);
    }

    return binance_empty_config_snapshot();
}

function binance_order_provider_snapshot(array $order)
{
    $providerId = isset($order['provider_id']) ? (int) $order['provider_id'] : null;
    $displayName = trim((string) ($order['display_name_snapshot'] ?? '')) ?: binance_provider_default_name();
    $providerSlug = trim((string) ($order['provider_slug_snapshot'] ?? '')) ?: binance_provider_default_slug();

    return [
        'provider_id' => $providerId > 0 ? $providerId : null,
        'display_name' => $displayName,
        'slug' => normalize_binance_provider_slug($providerSlug),
        'status' => isset($order['provider_status_snapshot']) ? (int) $order['provider_status_snapshot'] : 0,
        'note' => (string) ($order['note_snapshot'] ?? ''),
        'provider_note' => (string) ($order['provider_note_snapshot'] ?? $order['note_snapshot'] ?? ''),
        'pay_uid' => (string) ($order['pay_uid'] ?? ''),
        'account_name' => (string) ($order['account_name'] ?? ''),
        'qr_image_id' => !empty($order['provider_qr_image_id_snapshot']) ? (int) $order['provider_qr_image_id_snapshot'] : null,
        'qr_image_path' => (string) ($order['qr_image_path'] ?? ''),
        'instructions' => (string) ($order['provider_instructions_snapshot'] ?? $order['comment'] ?? ''),
        'min_usdt' => max(0, (float) ($order['usdt_amount'] ?? 0)),
        'api_key' => '',
        'api_secret' => '',
        'api_key_hash' => (string) ($order['provider_api_key_hash'] ?? '') ?: null,
        'is_legacy_migrated' => 0,
    ];
}

function binance_provider_required_snapshot($provider = null)
{
    if (is_array($provider) && !empty($provider)) {
        return binance_provider_row_to_snapshot($provider);
    }

    throw new InvalidArgumentException('Binance provider snapshot requires an explicit provider');
}

function binance_method_card_data($provider = null)
{
    $config = is_array($provider) && !empty($provider)
        ? binance_provider_required_snapshot($provider)
        : binance_empty_config_snapshot();

    return [
        'id' => 'binance-' . ($config['provider_id'] ?? $config['slug']),
        'provider_id' => $config['provider_id'],
        'name' => $config['display_name'],
        'slug' => $config['slug'],
        'type' => 'binance',
        'note' => $config['note'],
        'instructions' => $config['instructions'],
        'pay_uid' => $config['pay_uid'],
        'account_name' => $config['account_name'],
        'qr_image_path' => $config['qr_image_path'],
        'is_binance' => true,
    ];
}

function binance_enabled_method_cards()
{
    $cards = [];
    foreach (binance_all_providers(true) as $provider) {
        $cards[] = binance_method_card_data($provider);
    }
    return $cards;
}

function recharge_request_id_exists($requestId)
{
    global $duogxaolin;

    if (!$requestId) {
        return false;
    }

    $bankOrder = $duogxaolin->get_row("SELECT `id` FROM `autobank` WHERE `request_id` = ? LIMIT 1", [$requestId]);
    if ($bankOrder) {
        return true;
    }

    try {
        $dbInstance = Database::getInstance();
        $binanceTableExists = $dbInstance->fetch("SHOW TABLES LIKE 'recharge_binance'");
        if ($binanceTableExists) {
            $binanceOrder = $duogxaolin->get_row("SELECT `id` FROM `recharge_binance` WHERE `request_id` = ? LIMIT 1", [$requestId]);
            return (bool) $binanceOrder;
        }
        return false;
    } catch (Exception $e) {
        return false;
    }
}

function generate_recharge_request_id()
{
    do {
        $requestId = generate_unique_id();
    } while (recharge_request_id_exists($requestId));

    return $requestId;
}

function build_binance_qr_data(array $order)
{
    $imagePath = trim((string) ($order['qr_image_path'] ?? ''));

    return [
        'mode' => $imagePath !== '' ? 'image' : 'none',
        'value' => '',
        'image' => $imagePath,
        'has_qr' => $imagePath !== '',
        'manual_only' => $imagePath === '',
    ];
}

function get_binance_order_by_request_id($requestId, $userId)
{
    global $duogxaolin;

    try {
        return $duogxaolin->get_row(
            "SELECT * FROM `recharge_binance` WHERE `request_id` = ? AND `user_id` = ? LIMIT 1",
            [$requestId, $userId]
        );
    } catch (Exception $e) {
        return false;
    }
}

function binance_decode_matched_payload(array $row)
{
    $payload = $row['matched_payload_json'] ?? '';
    if (!is_string($payload) || trim($payload) === '') {
        return [];
    }

    $decoded = json_decode($payload, true);
    return is_array($decoded) ? $decoded : [];
}

function binance_first_non_empty(array $values)
{
    foreach ($values as $value) {
        if (is_scalar($value)) {
            $value = trim((string) $value);
            if ($value !== '') {
                return $value;
            }
        }
    }

    return '';
}

function binance_matched_order_type(array $row)
{
    $payload = binance_decode_matched_payload($row);
    return binance_first_non_empty([
        $row['order_type'] ?? null,
        $payload['orderType'] ?? null,
        $payload['bizType'] ?? null,
    ]);
}

function binance_matched_note(array $row)
{
    $payload = binance_decode_matched_payload($row);
    return binance_first_non_empty([
        $payload['note'] ?? null,
        $payload['remark'] ?? null,
        $payload['memo'] ?? null,
        $row['external_reference'] ?? null,
    ]);
}

function binance_history_comment(array $row)
{
    $baseComment = trim((string) ($row['comment'] ?? ''));
    $matchedNote = binance_matched_note($row);
    $transactionId = trim((string) ($row['external_transaction_id'] ?? ''));
    $orderType = binance_matched_order_type($row);

    $parts = [];
    if ($baseComment !== '') {
        $parts[] = $baseComment;
    }
    if ($matchedNote !== '') {
        $parts[] = 'Note: ' . $matchedNote;
    }
    if ($transactionId !== '') {
        $parts[] = 'Txn: ' . $transactionId;
    }
    if ($orderType !== '') {
        $parts[] = 'Type: ' . $orderType;
    }

    if (empty($parts)) {
        $parts[] = 'USDT';
    }

    return implode(' | ', array_values(array_unique($parts)));
}

function normalize_binance_history_row(array $row)
{
    $ctt = trim((string) ($row['display_name_snapshot'] ?? '')) ?: binance_display_name();
    $providerSlug = trim((string) ($row['provider_slug_snapshot'] ?? ''));
    $providerLabel = trim((string) ($row['display_name_snapshot'] ?? ''));
    $comment = binance_history_comment($row);

    if ($providerLabel !== '') {
        $comment .= ' | Provider: ' . $providerLabel;
        if ($providerSlug !== '') {
            $comment .= ' (' . $providerSlug . ')';
        }
    } elseif ($providerSlug !== '') {
        $comment .= ' | Provider: ' . $providerSlug;
    }

    return [
        'source' => 'binance',
        'request_id' => (string) $row['request_id'],
        'money_raw' => (float) ($row['money'] ?? 0),
        'money' => format_cash($row['money'] ?? 0),
        'ctt' => htmlspecialchars($ctt, ENT_QUOTES, 'UTF-8'),
        'comment' => htmlspecialchars($comment, ENT_QUOTES, 'UTF-8'),
        'time' => (int) ($row['created_at'] ?? $row['time'] ?? 0),
        'status' => (string) ($row['status'] ?? ''),
        'status_html' => status((string) ($row['status'] ?? '')),
        'link' => '/recharge/order/' . rawurlencode((string) $row['request_id']),
        'sort_id' => (int) ($row['id'] ?? 0),
    ];
}

function normalize_autobank_history_row(array $row, array $bankMap, array $cardMap)
{
    $link = 'javascript:void(0)';
    $ctt = 'Hệ thống';

    if (($row['type'] ?? '') === 'card') {
        $card = $cardMap[$row['request_id']] ?? null;
        if ($card) {
            $ctt = 'Thẻ cào ' . $card['loaithe'];
        }
    } else {
        $bank = $bankMap[$row['bank_id']] ?? null;
        if ($bank) {
            $link = '/recharge/order/' . $row['request_id'];
            $ctt = $bank['name'];
        }
    }

    return [
        'source' => 'bank',
        'request_id' => (string) $row['request_id'],
        'money_raw' => (float) ($row['money'] ?? 0),
        'money' => format_cash($row['money'] ?? 0),
        'ctt' => htmlspecialchars($ctt, ENT_QUOTES, 'UTF-8'),
        'comment' => htmlspecialchars((string) ($row['comment'] ?? ''), ENT_QUOTES, 'UTF-8'),
        'time' => (int) ($row['time'] ?? 0),
        'status' => (string) ($row['status'] ?? ''),
        'status_html' => status((string) ($row['status'] ?? '')),
        'link' => $link,
        'sort_id' => (int) ($row['id'] ?? 0),
    ];
}

function get_merged_recharge_history($userId, array $filters = [])
{
    global $duogxaolin;

    $conditions = ['`user_id` = ?'];
    $params = [$userId];

    $status = (string) ($filters['status'] ?? '');
    $trans = (string) ($filters['trans'] ?? '');
    $search = (string) ($filters['search'] ?? '');
    // from/to as unix times (fromTs/toTs from DateRangeFilter); startDate/endDate strings (server timezone) only for old callers
    $fromTs = isset($filters['fromTs']) ? (int) $filters['fromTs'] : (($filters['startDate'] ?? '') !== '' ? (int) strtotime($filters['startDate'] . ' 00:00:00') : 0);
    $toTs = isset($filters['toTs']) ? (int) $filters['toTs'] : (($filters['endDate'] ?? '') !== '' ? (int) strtotime($filters['endDate'] . ' 23:59:59') : 0);

    if ($status !== '') {
        $conditions[] = '`status` = ?';
        $params[] = $status;
    }

    if ($trans !== '') {
        $conditions[] = '`request_id` = ?';
        $params[] = $trans;
    }

    if ($search !== '') {
        $conditions[] = '(`request_id` LIKE ? OR `comment` LIKE ?)';
        $params[] = '%' . $search . '%';
        $params[] = '%' . $search . '%';
    }

    if ($fromTs > 0) {
        $conditions[] = '`time` >= ?';
        $params[] = $fromTs;
    }

    if ($toTs > 0) {
        $conditions[] = '`time` <= ?';
        $params[] = $toTs;
    }

    $where = implode(' AND ', $conditions);
    $autobankRows = $duogxaolin->get_list("SELECT * FROM `autobank` WHERE {$where}", $params);

    $binanceConditions = ['`user_id` = ?'];
    $binanceParams = [$userId];

    if ($status !== '') {
        $binanceConditions[] = '`status` = ?';
        $binanceParams[] = $status;
    }

    if ($trans !== '') {
        $binanceConditions[] = '`request_id` = ?';
        $binanceParams[] = $trans;
    }

    if ($search !== '') {
        $binanceConditions[] = '(`request_id` LIKE ? OR `comment` LIKE ? OR `external_transaction_id` LIKE ? OR `external_reference` LIKE ? OR `matched_payload_json` LIKE ?)';
        $like = '%' . $search . '%';
        $binanceParams[] = $like;
        $binanceParams[] = $like;
        $binanceParams[] = $like;
        $binanceParams[] = $like;
        $binanceParams[] = $like;
    }

    if ($fromTs > 0) {
        $binanceConditions[] = '`created_at` >= ?';
        $binanceParams[] = $fromTs;
    }

    if ($toTs > 0) {
        $binanceConditions[] = '`created_at` <= ?';
        $binanceParams[] = $toTs;
    }

    $binanceWhere = implode(' AND ', $binanceConditions);
    $binanceRows = [];
    try {
        $dbInstance = Database::getInstance();
        $binanceTableExists = $dbInstance->fetch("SHOW TABLES LIKE 'recharge_binance'");
        if ($binanceTableExists) {
            $binanceRows = $duogxaolin->get_list("SELECT * FROM `recharge_binance` WHERE {$binanceWhere}", $binanceParams);
        }
    } catch (Exception $e) {
        $binanceRows = [];
    }

    $bankIds = array_unique(array_filter(array_column($autobankRows, 'bank_id')));
    $cardCodes = [];
    foreach ($autobankRows as $row) {
        if (($row['type'] ?? '') === 'card' && !empty($row['request_id'])) {
            $cardCodes[] = $row['request_id'];
        }
    }
    $cardCodes = array_unique($cardCodes);

    $bankMap = [];
    if (!empty($bankIds)) {
        $placeholders = implode(',', array_fill(0, count($bankIds), '?'));
        foreach ($duogxaolin->get_list("SELECT `id`, `name` FROM `bank` WHERE `id` IN ({$placeholders})", array_values($bankIds)) as $bank) {
            $bankMap[$bank['id']] = $bank;
        }
    }

    $cardMap = [];
    if (!empty($cardCodes)) {
        $placeholders = implode(',', array_fill(0, count($cardCodes), '?'));
        foreach ($duogxaolin->get_list("SELECT `code`, `loaithe`, `pin`, `seri`, `menhgia` FROM `chargings_card` WHERE `code` IN ({$placeholders})", array_values($cardCodes)) as $card) {
            $cardMap[$card['code']] = $card;
        }
    }

    $rows = [];
    foreach ($autobankRows as $row) {
        $rows[] = normalize_autobank_history_row($row, $bankMap, $cardMap);
    }
    foreach ($binanceRows as $row) {
        $rows[] = normalize_binance_history_row($row);
    }

    usort($rows, function ($left, $right) use ($filters) {
        $sort = (string) ($filters['sort'] ?? '');
        if ($left['time'] === $right['time']) {
            if ($sort === 'oldest') {
                return $left['sort_id'] <=> $right['sort_id'];
            }
            return $right['sort_id'] <=> $left['sort_id'];
        }
        if ($sort === 'oldest') {
            return $left['time'] <=> $right['time'];
        }
        return $right['time'] <=> $left['time'];
    });

    return $rows;
}

/**
 * WHERE clause and parameters of the recharge list filters for one of the two tables: 'bank' (autobank) or 'binance' (recharge_binance).
 * $userId null = every user. Same filters as get_merged_recharge_history().
 *
 * @return array{0:string,1:array}
 */
function recharge_history_conditions(?int $userId, array $filters, string $kind): array
{
    $isBinance = $kind === 'binance';
    $conditions = [$userId === null ? '`id` IS NOT NULL' : '`user_id` = ?'];
    $params = $userId === null ? [] : [$userId];

    $status = (string) ($filters['status'] ?? '');
    $trans = (string) ($filters['trans'] ?? '');
    $search = (string) ($filters['search'] ?? '');
    // from/to as unix times (fromTs/toTs from DateRangeFilter); startDate/endDate strings (server timezone) only for old callers
    $fromTs = isset($filters['fromTs']) ? (int) $filters['fromTs'] : (($filters['startDate'] ?? '') !== '' ? (int) strtotime($filters['startDate'] . ' 00:00:00') : 0);
    $toTs = isset($filters['toTs']) ? (int) $filters['toTs'] : (($filters['endDate'] ?? '') !== '' ? (int) strtotime($filters['endDate'] . ' 23:59:59') : 0);
    $timeColumn = $isBinance ? '`created_at`' : '`time`';

    if ($status !== '') {
        $conditions[] = '`status` = ?';
        $params[] = $status;
    }
    if ($trans !== '') {
        $conditions[] = '`request_id` = ?';
        $params[] = $trans;
    }
    if ($search !== '') {
        $like = '%' . $search . '%';
        if ($isBinance) {
            $conditions[] = '(`request_id` LIKE ? OR `comment` LIKE ? OR `external_transaction_id` LIKE ? OR `external_reference` LIKE ? OR `matched_payload_json` LIKE ?)';
            array_push($params, $like, $like, $like, $like, $like);
        } else {
            $conditions[] = '(`request_id` LIKE ? OR `comment` LIKE ?)';
            array_push($params, $like, $like);
        }
    }
    if ($fromTs > 0) {
        $conditions[] = "$timeColumn >= ?";
        $params[] = $fromTs;
    }
    if ($toTs > 0) {
        $conditions[] = "$timeColumn <= ?";
        $params[] = $toTs;
    }
    return [implode(' AND ', $conditions), $params];
}

/**
 * One page of the merged bank + Binance recharge history for the admin list ($userId null = every user), newest first or, with
 * $filters['sort'] === 'oldest', oldest first. Counting, ordering and paging happen in SQL over narrow (source, id, time) rows and only
 * the rows of the page are loaded in full, so memory does not grow with the tables. The list used to read every row of both tables into
 * PHP, build an array per row, sort them there and cut the page out: it ran out of memory (128 MB) once the history was large.
 *
 * Each row carries what the admin list needs on top of the normalized fields: raw_id, user_id, type, amount, money_s.
 *
 * @return array{rows: array<int,array>, total: int}
 */
function get_recharge_history_page(?int $userId, array $filters, int $limit, int $offset): array
{
    $db = Database::getInstance();
    $limit = max(1, $limit);
    $offset = max(0, $offset);
    $dir = (($filters['sort'] ?? '') === 'oldest') ? 'ASC' : 'DESC';

    [$bankWhere, $bankParams] = recharge_history_conditions($userId, $filters, 'bank');
    $hasBinance = false;
    try {
        $hasBinance = (bool) $db->fetch("SHOW TABLES LIKE 'recharge_binance'");
    } catch (Exception $e) {
        $hasBinance = false;
    }

    // `time` is a varchar holding a unix time: sort it as a number
    $top = $offset + $limit;
    $branches = ["(SELECT 'bank' AS `src`, `id`, CAST(`time` AS UNSIGNED) AS `t` FROM `autobank` WHERE {$bankWhere} ORDER BY `t` $dir, `id` $dir LIMIT $top)"];
    $params = $bankParams;
    $total = (int) ($db->fetch("SELECT COUNT(*) AS `c` FROM `autobank` WHERE {$bankWhere}", $bankParams)['c'] ?? 0);

    if ($hasBinance) {
        [$binanceWhere, $binanceParams] = recharge_history_conditions($userId, $filters, 'binance');
        $branches[] = "(SELECT 'binance' AS `src`, `id`, `created_at` AS `t` FROM `recharge_binance` WHERE {$binanceWhere} ORDER BY `t` $dir, `id` $dir LIMIT $top)";
        $params = array_merge($params, $binanceParams);
        $total += (int) ($db->fetch("SELECT COUNT(*) AS `c` FROM `recharge_binance` WHERE {$binanceWhere}", $binanceParams)['c'] ?? 0);
    }

    // the first $offset + $limit rows of each table are enough to find the page of the union: nothing more is read
    $page = $total === 0 || $offset >= $total ? [] : $db->fetchAll(
        implode(' UNION ALL ', $branches) . " ORDER BY `t` $dir, `id` $dir, `src` LIMIT $limit OFFSET $offset",
        $params
    );

    $ids = ['bank' => [], 'binance' => []];
    foreach ($page as $r) {
        $ids[$r['src']][] = (int) $r['id'];
    }
    $fetchByIds = static function (string $table, array $list) use ($db): array {
        if (!$list) {
            return [];
        }
        $byId = [];
        foreach ($db->fetchAll("SELECT * FROM `$table` WHERE `id` IN (" . implode(',', array_fill(0, count($list), '?')) . ')', $list) as $row) {
            $byId[(int) $row['id']] = $row;
        }
        return $byId;
    };
    $bankRows = $fetchByIds('autobank', $ids['bank']);
    $binanceRows = $hasBinance ? $fetchByIds('recharge_binance', $ids['binance']) : [];

    $bankMap = [];
    $bankIds = array_unique(array_filter(array_column($bankRows, 'bank_id')));
    if ($bankIds) {
        foreach ($db->fetchAll('SELECT `id`, `name` FROM `bank` WHERE `id` IN (' . implode(',', array_fill(0, count($bankIds), '?')) . ')', array_values($bankIds)) as $b) {
            $bankMap[$b['id']] = $b;
        }
    }
    $cardCodes = [];
    foreach ($bankRows as $row) {
        if (($row['type'] ?? '') === 'card' && !empty($row['request_id'])) {
            $cardCodes[] = $row['request_id'];
        }
    }
    $cardMap = [];
    $cardCodes = array_unique($cardCodes);
    if ($cardCodes) {
        foreach ($db->fetchAll('SELECT `code`, `loaithe`, `pin`, `seri`, `menhgia` FROM `chargings_card` WHERE `code` IN (' . implode(',', array_fill(0, count($cardCodes), '?')) . ')', array_values($cardCodes)) as $c) {
            $cardMap[$c['code']] = $c;
        }
    }

    $rows = [];
    foreach ($page as $r) {
        $id = (int) $r['id'];
        if ($r['src'] === 'binance') {
            $row = $binanceRows[$id] ?? null;
            if ($row === null) {
                continue;
            }
            $normalized = normalize_binance_history_row($row);
            $normalized['type'] = 'binance';
            $normalized['amount'] = (float) ($row['usdt_amount'] ?? 0);
            $normalized['money_s'] = (float) ($row['money_s'] ?? $row['money'] ?? 0);
        } else {
            $row = $bankRows[$id] ?? null;
            if ($row === null) {
                continue;
            }
            $normalized = normalize_autobank_history_row($row, $bankMap, $cardMap);
            $normalized['type'] = (string) ($row['type'] ?? '');
            $normalized['amount'] = (float) ($row['amount'] ?? 0);
            $normalized['money_s'] = (float) ($row['money_s'] ?? 0);
        }
        $normalized['raw_id'] = $id;
        $normalized['user_id'] = (int) ($row['user_id'] ?? 0);
        $rows[] = $normalized;
    }

    return ['rows' => $rows, 'total' => $total];
}

function binance_order_view_data(array $order, $domain)
{
    $currency = trim((string) ($order['display_currency'] ?? '')) ?: binance_option_value('c', 'VND');
    $providerSnapshot = binance_order_provider_snapshot($order);
    $displayName = $providerSnapshot['display_name'];
    $note = trim((string) ($order['note_snapshot'] ?? ''));
    if ($note === '') {
        $note = trim((string) ($order['provider_note_snapshot'] ?? ''));
    }
    $instructions = trim((string) ($order['provider_instructions_snapshot'] ?? $order['comment'] ?? ''));
    $qr = build_binance_qr_data($order);

    return [
        'title' => 'Nạp tiền đơn hàng ' . $order['request_id'] . ' Tại ' . $domain,
        'domain' => $domain,
        'code' => $order['request_id'],
        'logo' => binance_option_value('logo', ''),
        'time' => showTime((int) ($order['created_at'] ?? time())),
        'time_ts' => (int) ($order['created_at'] ?? time()),
        'status' => (string) ($order['status'] ?? ''),
        'status_html' => status((string) ($order['status'] ?? '')),
        'money' => (float) ($order['money'] ?? 0),
        'money_raw' => (float) ($order['money'] ?? 0),
        'money_s' => (float) ($order['money_s'] ?? $order['money'] ?? 0),
        'fees' => (float) ($order['fees'] ?? 0),
        'currency' => $currency,
        'gateway_type' => 'binance',
        'gateway_name' => $displayName,
        'note' => $note,
        'comment' => $instructions,
        'binance_provider_id' => !empty($order['provider_id']) ? (int) $order['provider_id'] : null,
        'binance_provider_slug' => (string) ($order['provider_slug_snapshot'] ?? ''),
        'binance_usdt_amount' => (float) ($order['usdt_amount'] ?? 0),
        'binance_rate_usd' => (float) ($order['rate_usd'] ?? 1),
        'binance_uid' => (string) ($order['pay_uid'] ?? ''),
        'binance_account_name' => (string) ($order['account_name'] ?? ''),
        'binance_external_transaction_id' => (string) ($order['external_transaction_id'] ?? ''),
        'binance_reference' => (string) ($order['external_reference'] ?? ''),
        'binance_matched_note' => binance_matched_note($order),
        'binance_order_type' => binance_matched_order_type($order),
        'binance_history_comment' => binance_history_comment($order),
        'binance_qr' => $qr,
        'qr_url' => $qr['image'] ?: '',
    ];
}
