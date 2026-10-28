// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
export const SCHEMA_VERSION = 8;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      // Advanced key limits (null = unlimited / unset)
      groupId: "TEXT",
      rpm: "INTEGER",
      tpm: "INTEGER",
      budgetUsd: "REAL",
      resetWindow: "TEXT",
      expiresAt: "TEXT",
      allowedModels: "TEXT",
      windowStartedAt: "TEXT",
      windowCostUsd: "REAL DEFAULT 0",
      updatedAt: "TEXT",
      // Tenant ownership + dual-read lookup (key kept for backward compatibility;
      // keyHash is the sha256 of the raw key, keyPrefix its first 8 chars).
      userId: "TEXT",
      keyHash: "TEXT",
      keyPrefix: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)",
      "CREATE INDEX IF NOT EXISTS idx_ak_group ON apiKeys(groupId)",
      "CREATE INDEX IF NOT EXISTS idx_ak_user ON apiKeys(userId)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ak_keyhash ON apiKeys(keyHash)",
    ],
  },
  keyGroups: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      isActive: "INTEGER DEFAULT 1",
      rpm: "INTEGER",
      tpm: "INTEGER",
      budgetUsd: "REAL",
      resetWindow: "TEXT",
      allowedModels: "TEXT",
      priceOverrides: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kg_name ON keyGroups(name)"],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      // JSON blob for additive one-off fields (capabilities, etc.) — avoids ALTER.
      meta: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      // DEPRECATED: raw API-key secret. New rows leave this NULL and store only
      // apiKeyId; it is kept so historical rows (written before the migration)
      // remain attributable. Never write a secret here when the owner resolves.
      apiKey: "TEXT",
      // Owning apiKeys.id for rows written from this release on. Nullable: legacy
      // rows have none until migration 005 backfills what it can.
      apiKeyId: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      // Authoritative cost in integer nanoUSD (1e-9 USD). `cost` (REAL) is kept
      // only for legacy readers; writers set both.
      costNanoUsd: "INTEGER DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_uh_apikey_ts ON usageHistory(apiKey, timestamp DESC)",
      // New lookup path: rows written from this release on carry apiKeyId instead
      // of the raw secret. idx_uh_apikey_ts stays for legacy rows and for the
      // dual-path reads until the next release can drop `apiKey`.
      "CREATE INDEX IF NOT EXISTS idx_uh_apikeyid_ts ON usageHistory(apiKeyId, timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_ts_nano ON usageHistory(timestamp DESC, costNanoUsd)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_rd_apikey_ts ON requestDetails(apiKey, timestamp DESC)",
    ],
  },

  // ── Tenants & billing ──────────────────────────────────────────────────
  // All money columns are integer nanoUSD (1e-9 USD). Never floats.
  users: {
    columns: {
      id: "TEXT PRIMARY KEY",
      email: "TEXT UNIQUE NOT NULL",
      passwordHash: "TEXT NOT NULL",
      displayName: "TEXT",
      groupId: "TEXT",
      status: "TEXT NOT NULL",
      overdraftNanoUsd: "INTEGER DEFAULT 0",
      createdAt: "TEXT",
      updatedAt: "TEXT",
      lastLoginAt: "TEXT",
    },
    indexes: ["CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)"],
  },
  userSessions: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT NOT NULL",
      tokenHash: "TEXT UNIQUE NOT NULL",
      createdAt: "TEXT",
      expiresAt: "TEXT",
      ip: "TEXT",
      userAgent: "TEXT",
      revokedAt: "TEXT",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_us_user ON userSessions(userId)"],
  },
  emailVerifications: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT NOT NULL",
      tokenHash: "TEXT UNIQUE NOT NULL",
      purpose: "TEXT NOT NULL",
      expiresAt: "TEXT NOT NULL",
      consumedAt: "TEXT",
      createdAt: "TEXT",
    },
    // tokenHash is UNIQUE (auto-indexed); that is the only lookup path.
    indexes: [],
  },
  plans: {
    columns: {
      id: "TEXT PRIMARY KEY",
      code: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      description: "TEXT",
      priceNanoUsd: "INTEGER NOT NULL",
      creditNanoUsd: "INTEGER NOT NULL",
      durationDays: "INTEGER NOT NULL",
      isActive: "INTEGER DEFAULT 1",
      sortOrder: "INTEGER",
      createdAt: "TEXT",
      updatedAt: "TEXT",
    },
    // code is UNIQUE inline (auto-indexed) — that covers lookup by code.
    indexes: [],
  },
  // Per-model allowance for a subscription plan, modelled on how OpenCode Go
  // meters its plans: a monthly dollar ceiling PER MODEL, drawn down by that
  // model's own traffic. Zero rows for a plan means "no per-model ceiling" and
  // the plan falls back to its flat creditNanoUsd, so existing plans keep
  // working untouched.
  //
  // monthlyNanoUsd is the 100% ceiling. The shorter windows are derived, not
  // stored: 5h = 20% and week = 50% of it. Storing them would let an admin
  // create a plan whose windows contradict each other.
  planModelLimits: {
    columns: {
      id: "TEXT PRIMARY KEY",
      planId: "TEXT NOT NULL",
      // Model id as sent by the client. Matched with matchesAllowed() so a
      // wildcard entry ("anthropic/*") covers a whole family.
      model: "TEXT NOT NULL",
      monthlyNanoUsd: "INTEGER NOT NULL",
      createdAt: "TEXT",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_pml_plan_model ON planModelLimits(planId, model)",
    ],
  },
  orders: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT NOT NULL",
      planId: "TEXT NOT NULL",
      amountNanoUsd: "INTEGER",
      creditNanoUsd: "INTEGER",
      durationDays: "INTEGER",
      status: "TEXT NOT NULL",
      method: "TEXT DEFAULT 'manual'",
      payerNote: "TEXT",
      adminNote: "TEXT",
      approvedBy: "TEXT",
      createdAt: "TEXT",
      paidAt: "TEXT",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(userId, status)"],
  },
  userPlans: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT NOT NULL",
      // NULL for a credit-only grant: a gift code with grantKind='credit' or an
      // admin adjustment credits the wallet without any plans row behind it.
      planId: "TEXT",
      orderId: "TEXT",
      source: "TEXT NOT NULL",
      creditTotalNanoUsd: "INTEGER NOT NULL",
      creditRemainingNanoUsd: "INTEGER NOT NULL",
      startsAt: "TEXT NOT NULL",
      expiresAt: "TEXT NOT NULL",
      status: "TEXT NOT NULL",
      createdAt: "TEXT",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_up_user ON userPlans(userId, status, expiresAt)"],
  },
  creditLedger: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      userId: "TEXT NOT NULL",
      userPlanId: "TEXT",
      apiKeyId: "TEXT",
      // Idempotency key: one ledger row per request/charge.
      requestKey: "TEXT UNIQUE",
      deltaNanoUsd: "INTEGER NOT NULL",
      balanceAfterNanoUsd: "INTEGER",
      kind: "TEXT NOT NULL",
      meta: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_cl_user_ts ON creditLedger(userId, createdAt)"],
  },
  giftCodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      code: "TEXT UNIQUE NOT NULL",
      grantKind: "TEXT NOT NULL",
      planId: "TEXT",
      creditNanoUsd: "INTEGER",
      durationDays: "INTEGER",
      maxRedemptions: "INTEGER DEFAULT 1",
      redeemedCount: "INTEGER DEFAULT 0",
      perUserLimit: "INTEGER DEFAULT 1",
      startsAt: "TEXT",
      expiresAt: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      note: "TEXT",
      createdBy: "TEXT",
      createdAt: "TEXT",
      updatedAt: "TEXT",
    },
    // code is UNIQUE inline (auto-indexed) — that covers redemption lookup.
    indexes: [],
  },
  giftRedemptions: {
    columns: {
      id: "TEXT PRIMARY KEY",
      giftId: "TEXT NOT NULL",
      userId: "TEXT NOT NULL",
      userPlanId: "TEXT",
      redeemedAt: "TEXT",
    },
    // No UNIQUE(giftId, userId) here on purpose: a code may be redeemed up to
    // giftCodes.perUserLimit times by the same account, and that limit is
    // admin-configurable, so a hard constraint cannot express it. Uniqueness of
    // a redemption is per (giftId, userId) up to that limit, enforced by the
    // synchronous claim transaction in redeemGiftCode — not by a constraint.
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_gr_gift_user ON giftRedemptions(giftId, userId)",
      "CREATE INDEX IF NOT EXISTS idx_gr_user ON giftRedemptions(userId)",
    ],
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
