<?php

require_once __DIR__ . '/BaseModel.php';

class BinanceProvider extends BaseModel
{
    private static $tableChecked = null;
    private static $orderTableChecked = null;

    private function tableExists(): bool
    {
        if (self::$tableChecked !== null) {
            return self::$tableChecked;
        }
        try {
            $dbInstance = Database::getInstance();
            $result = $dbInstance->fetch("SHOW TABLES LIKE 'binance_provider'");
            self::$tableChecked = !empty($result);
        } catch (Exception $e) {
            self::$tableChecked = false;
        }
        return self::$tableChecked;
    }

    private function orderTableExists(): bool
    {
        if (self::$orderTableChecked !== null) {
            return self::$orderTableChecked;
        }
        try {
            $dbInstance = Database::getInstance();
            $result = $dbInstance->fetch("SHOW TABLES LIKE 'recharge_binance'");
            self::$orderTableChecked = !empty($result);
        } catch (Exception $e) {
            self::$orderTableChecked = false;
        }
        return self::$orderTableChecked;
    }

    public function all(bool $includeDisabled = true): array
    {
        if (!$this->tableExists()) {
            return [];
        }
        $where = $includeDisabled ? '1' : '`status` = 1';
        return $this->list("SELECT bp.*, c.id AS cron_id, c.hash AS cron_hash, c.url AS cron_url, c.enabled AS cron_enabled, c.interval_seconds AS cron_interval_seconds, c.last_run AS cron_last_run FROM `binance_provider` bp LEFT JOIN `cron` c ON c.`type` = 'binance_payment' AND c.`reference_id` = bp.`id` WHERE {$where} ORDER BY bp.`status` DESC, bp.`id` DESC");
    }

    public function enabled(): array
    {
        return $this->all(false);
    }

    public function find(int $id): ?array
    {
        if (!$this->tableExists()) {
            return null;
        }
        return $this->row("SELECT bp.*, c.id AS cron_id, c.hash AS cron_hash, c.url AS cron_url, c.enabled AS cron_enabled, c.interval_seconds AS cron_interval_seconds, c.last_run AS cron_last_run FROM `binance_provider` bp LEFT JOIN `cron` c ON c.`type` = 'binance_payment' AND c.`reference_id` = bp.`id` WHERE bp.`id` = ? LIMIT 1", [$id]);
    }

    public function findBySlug(string $slug, bool $enabledOnly = false): ?array
    {
        if (!$this->tableExists()) {
            return null;
        }
        $query = "SELECT bp.*, c.id AS cron_id, c.hash AS cron_hash, c.url AS cron_url, c.enabled AS cron_enabled, c.interval_seconds AS cron_interval_seconds, c.last_run AS cron_last_run FROM `binance_provider` bp LEFT JOIN `cron` c ON c.`type` = 'binance_payment' AND c.`reference_id` = bp.`id` WHERE bp.`slug` = ?";
        $params = [$slug];
        if ($enabledOnly) {
            $query .= " AND bp.`status` = 1";
        }
        $query .= " LIMIT 1";
        return $this->row($query, $params);
    }

    public function create(array $data)
    {
        if (!$this->tableExists()) {
            return false;
        }
        $insertId = $this->db->insert('binance_provider', $data);
        if (!$insertId) {
            return false;
        }
        return $insertId;
    }

    public function updateById(int $id, array $data): bool
    {
        if (!$this->tableExists()) {
            return false;
        }
        return (bool) $this->db->update('binance_provider', $data, '`id` = ?', [$id]);
    }

    public function deleteById(int $id): bool
    {
        if (!$this->tableExists()) {
            return false;
        }
        return (bool) $this->db->remove('binance_provider', '`id` = ?', [$id]);
    }

    public function countOrders(int $providerId): int
    {
        if (!$this->orderTableExists()) {
            return 0;
        }
        return $this->count('recharge_binance', '`provider_id` = ?', [$providerId]);
    }

    public function countPendingOrders(int $providerId): int
    {
        if (!$this->orderTableExists()) {
            return 0;
        }
        return $this->count('recharge_binance', '`provider_id` = ? AND `status` = ?', [$providerId, 'xuly']);
    }

    public function findByQrImageId(int $imageId, ?int $excludeId = null): ?array
    {
        if (!$this->tableExists()) {
            return null;
        }
        $query = "SELECT * FROM `binance_provider` WHERE `qr_image_id` = ?";
        $params = [$imageId];

        if ($excludeId !== null && $excludeId > 0) {
            $query .= " AND `id` != ?";
            $params[] = $excludeId;
        }

        $query .= " LIMIT 1";
        return $this->row($query, $params);
    }

    public function findLegacyMigrated(): ?array
    {
        if (!$this->tableExists()) {
            return null;
        }
        return $this->row("SELECT * FROM `binance_provider` WHERE `is_legacy_migrated` = 1 ORDER BY `id` ASC LIMIT 1");
    }
}
