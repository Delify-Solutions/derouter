// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
export const SCHEMA_VERSION = 20;

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

  // Failed requests kept for debugging (admin "Nhật ký lỗi" page). One row per failed
  // request: the error, what was asked and which upstream attempts failed. Never holds
  // a raw API key — only apiKeyId plus an owner label snapshot. Pruned by age and count.
  errorLogs: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      // upstream | platform | request | router | stream
      source: "TEXT NOT NULL",
      // Final HTTP status the client saw; 200 for a stream that failed after it started.
      status: "INTEGER DEFAULT 0",
      endpoint: "TEXT",
      requestedModel: "TEXT",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      connectionName: "TEXT",
      apiKeyId: "TEXT",
      owner: "TEXT",
      errorCode: "TEXT",
      message: "TEXT",
      stream: "INTEGER DEFAULT 0",
      bodyBytes: "INTEGER DEFAULT 0",
      estTokens: "INTEGER DEFAULT 0",
      messageCount: "INTEGER DEFAULT 0",
      latencyMs: "INTEGER DEFAULT 0",
      // JSON: { request, upstreamRequest, response, attempts, preview, truncated, userAgent }
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_el_ts ON errorLogs(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_el_source_ts ON errorLogs(source, timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_el_status_ts ON errorLogs(status, timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_el_model ON errorLogs(requestedModel)",
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
      // Free-text internal note the operator keeps on the account (support
      // context, arrangements made out of band). Editable without a reason —
      // it changes nothing about what the customer can do.
      adminNote: "TEXT",
      createdAt: "TEXT",
      updatedAt: "TEXT",
      lastLoginAt: "TEXT",
    },
    indexes: ["CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)"],
  },
  // Every admin or system action on a customer account, with who did it and why.
  //
  // A row here is the explanation for a money movement recorded in creditLedger:
  // the ledger says what changed, this says who caused it and on whose authority.
  // `userId` is intentionally NOT a foreign key — the audit trail of a deleted
  // user's deletion must survive the cascade that removes everything else. When
  // the user row is gone, `details` still carries the email.
  userAuditLog: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT NOT NULL",
      // "admin:<identity>", "customer" or "system".
      actor: "TEXT NOT NULL",
      action: "TEXT NOT NULL",
      reason: "TEXT",
      // JSON `{ before, after, ... }` — free-form per action.
      details: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    // The only read pattern is "this user's log, newest first".
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ual_user_ts ON userAuditLog(userId, createdAt DESC)"],
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
      // VietQR price in integer đồng (spec plan-dual-pricing "Two prices per plan").
      // NULL or 0 = the plan is not sold by bank transfer. Deliberately NOT derived
      // from priceNanoUsd: no exchange rate is involved on either side, so the
      // admin can price 250.000đ independently of $10.
      priceVnd: "INTEGER",
      creditNanoUsd: "INTEGER NOT NULL",
      // 1 = the plan has no credit ceiling: requests are never refused for lack of
      // credit and only the per-window limits / RPM / TPM bound the spend.
      // creditNanoUsd is 0 for such a plan. A flag rather than a huge credit
      // number so no SUM(creditRemainingNanoUsd) or credit display has to know
      // about a fake amount.
      unlimitedCredit: "INTEGER DEFAULT 0",
      // 1 = the customer may type any amount in đồng and receive credit at this
      // plan's own rate (priceVnd đồng buys creditNanoUsd). The bounds below are in
      // đồng; NULL min = the plan's price, NULL max = a built-in ceiling.
      allowCustomAmount: "INTEGER DEFAULT 0",
      customMinVnd: "INTEGER",
      customMaxVnd: "INTEGER",
      durationDays: "INTEGER NOT NULL",
      // Visibility vs purchasability are two separate switches on purpose:
      //   isActive     listed on the public pricing page at all
      //   isPurchasable  the buy button works; false = "coming soon" / retired
      //                  but still shown, which is how a plan can be advertised
      //                  before its capacity exists.
      isActive: "INTEGER DEFAULT 1",
      isPurchasable: "INTEGER DEFAULT 1",
      // NULL = any group may buy. Otherwise a JSON array of keyGroups ids: the
      // plan is restricted to customers whose users.groupId is in the list.
      // Stored as JSON rather than a join table because it is read as a whole
      // unit (is this group allowed?) and never queried per member.
      allowedGroupIds: "TEXT",
      // Purchases allowed per calendar month. NULL or 0 = unlimited. Counted
      // over orders, not userPlans, so a refund re-opens the slot.
      purchaseLimitPerMonth: "INTEGER",
      // Per-window spending limits: a JSON array of { hours, maxNanoUsd } sorted
      // by hours. NULL/[] = no limits (the purchase drains its credit freely).
      // Snapshotted into the order and the granted purchase, so editing a plan
      // never rewrites what a customer already bought.
      limits: "TEXT",
      // Request and token rate for every customer whose paying plan is this one
      // (requests per minute / tokens per minute). NULL = unlimited. Read live from
      // the plan, not snapshotted: unlike credit, a rate is not something the
      // customer bought, so a corrected value should apply to everyone at once.
      rpm: "INTEGER",
      tpm: "INTEGER",
      // Highlighted card on the landing page ("most popular").
      isFeatured: "INTEGER DEFAULT 0",
      sortOrder: "INTEGER",
      createdAt: "TEXT",
      updatedAt: "TEXT",
    },
    // code is UNIQUE inline (auto-indexed) — that covers lookup by code.
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_plans_visible ON plans(isActive, sortOrder)",
    ],
  },
  // Operator-authored documentation served at /docs/<slug>.
  //
  // A table rather than keys inside `settings`: these are rows (slug, title,
  // ordering) that need to be listed and queried one at a time, while settings
  // is a single JSON blob where every write rewrites the whole document.
  docsPages: {
    columns: {
      id: "TEXT PRIMARY KEY",
      // The URL segment. Lowercase and dash-separated so it is stable in links;
      // validated in contentRepo, not constrained here, because the reserved-word
      // list is an application rule that may grow.
      slug: "TEXT UNIQUE NOT NULL",
      title: "TEXT NOT NULL",
      summary: "TEXT",
      // Markdown. Rendered through the sanitising pipeline in
      // shared/utils/markdown.js — never injected raw.
      body: "TEXT NOT NULL",
      isPublished: "INTEGER DEFAULT 0",
      // Grouping for the docs sidebar, mirroring how opencode.ai/v2/docs splits
      // its navigation into CLI / Build / API / Console. A page belongs to one
      // section; the section list is derived from the pages themselves so an
      // admin can invent a new group simply by typing it.
      section: "TEXT",
      // Card description on the docs index. Separate from `summary` so the index
      // can stay terse while the page header keeps its longer intro.
      excerpt: "TEXT",
      sortOrder: "INTEGER DEFAULT 0",
      createdAt: "TEXT",
      updatedAt: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_docs_published ON docsPages(isPublished, section, sortOrder)",
    ],
  },
  orders: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT NOT NULL",
      planId: "TEXT NOT NULL",
      // Buyer email copied at order creation. Orders outlive the account they
      // belong to (deleting a customer keeps their orders for accounting), so the
      // email must not be reachable only through the users row. Named *Snapshot*
      // because ORDER_SELECT already aliases `u.email AS userEmail`; the select
      // reads COALESCE(u.email, o.emailSnapshot) so both paths work.
      emailSnapshot: "TEXT",
      // Snapshot of the plan's limits at order creation (JSON). NULL for orders
      // created before GĐ1, which are granted with the plan's current limits.
      limits: "TEXT",
      amountNanoUsd: "INTEGER",
      creditNanoUsd: "INTEGER",
      // Snapshot of plans.unlimitedCredit at order creation, like the limits above.
      unlimitedCredit: "INTEGER DEFAULT 0",
      durationDays: "INTEGER",
      status: "TEXT NOT NULL",
      method: "TEXT DEFAULT 'manual'",
      // ── Gateway payment (design D1) ───────────────────────────────────────
      // Payment code written in the transfer content, e.g. DR8K3Q7MZP. Unique
      // across orders so a bank memo can only ever name one order; manual orders
      // leave it NULL and SQLite allows many NULLs under one UNIQUE index.
      paymentCode: "TEXT",
      // USD (manual), VND (VietQR) or USDT (Binance Pay).
      payCurrency: "TEXT",
      // What the customer must actually send: đồng for VND, nano-USDT for USDT,
      // nano-USD for a manual order. Snapshotted so a later plan edit cannot
      // change the amount a customer was told to pay.
      payAmount: "INTEGER",
      paymentProviderId: "TEXT",
      // ISO expiry; set for gateway orders only. A pending order past this
      // instant is swept to status 'expired' by the payment poller.
      expiresAt: "TEXT",
      // The paymentTransactions row that approved this order, when one did.
      paymentTransactionId: "TEXT",
      payerNote: "TEXT",
      adminNote: "TEXT",
      approvedBy: "TEXT",
      createdAt: "TEXT",
      paidAt: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(userId, status)",
      // One order per payment code. Many NULLs are allowed by SQLite, so manual
      // orders (no code) coexist with gateway orders under this index.
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_paycode ON orders(paymentCode)",
      // The poller sweeps pending gateway orders by expiry.
      "CREATE INDEX IF NOT EXISTS idx_orders_expiry ON orders(status, expiresAt)",
    ],
  },
  // A receiving account the operator can be paid into (design D1).
  //
  // `config` holds the non-secret description of the account (bank BIN, display
  // name, account number, API base URL, identity overrides) so the admin list and
  // the checkout page can read it without decrypting anything. `secrets` holds a
  // JSON object whose every value is `encryptSecret` output — it is only ever
  // decrypted by getProviderWithSecrets() for a fetch, never returned by an API.
  paymentProviders: {
    columns: {
      id: "TEXT PRIMARY KEY",
      // sepay | web2m | acb | binance
      kind: "TEXT NOT NULL",
      name: "TEXT NOT NULL",
      isActive: "INTEGER DEFAULT 1",
      // Which active provider of a kind a new order uses: lowest sortOrder wins.
      sortOrder: "INTEGER DEFAULT 0",
      config: "TEXT",
      secrets: "TEXT",
      pollIntervalSeconds: "INTEGER DEFAULT 30",
      lastPolledAt: "TEXT",
      lastError: "TEXT",
      createdAt: "TEXT",
      updatedAt: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pprov_kind ON paymentProviders(kind, isActive, sortOrder)",
    ],
  },
  // Every transaction received from a provider, stored exactly once (design D1).
  //
  // The UNIQUE (providerId, externalId) index is the deduplication guarantee: the
  // webhook and the poller may see the same transfer, and the second INSERT loses
  // instead of approving an order twice.
  paymentTransactions: {
    columns: {
      id: "TEXT PRIMARY KEY",
      providerId: "TEXT NOT NULL",
      // Provider kind copied at ingest time so a transaction stays attributable
      // after its provider row is edited.
      kind: "TEXT NOT NULL",
      externalId: "TEXT NOT NULL",
      // đồng for VND, nano-USDT for USDT. Always positive; direction carries sign.
      amount: "INTEGER NOT NULL",
      currency: "TEXT NOT NULL",
      content: "TEXT",
      occurredAt: "TEXT",
      receivedAt: "TEXT NOT NULL",
      // webhook | poll
      via: "TEXT",
      raw: "TEXT",
      // matched | needs_review | resolved
      status: "TEXT NOT NULL",
      reason: "TEXT",
      orderId: "TEXT",
      resolvedBy: "TEXT",
      resolvedAt: "TEXT",
      resolutionNote: "TEXT",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ptx_provider_external ON paymentTransactions(providerId, externalId)",
      "CREATE INDEX IF NOT EXISTS idx_ptx_status_time ON paymentTransactions(status, receivedAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_ptx_order ON paymentTransactions(orderId)",
    ],
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
      // 1 = no credit ceiling (both credit columns stay 0 and are never spent
      // down); charges are still ledgered and still counted by the windows.
      unlimitedCredit: "INTEGER DEFAULT 0",
      startsAt: "TEXT NOT NULL",
      expiresAt: "TEXT NOT NULL",
      status: "TEXT NOT NULL",
      // Explicit queue position written by a customer reorder or an admin action.
      // NULL = never ordered, which sorts AFTER every plan that has one.
      priority: "INTEGER",
      // Snapshot of the plan's per-window limits at grant time (JSON array of
      // { hours, maxNanoUsd }); NULL/[] = no limits.
      limits: "TEXT",
      createdAt: "TEXT",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_up_user ON userPlans(userId, status, expiresAt)"],
  },
  // One row per (purchase, window length) holding the current window's start and
  // spend. A window "opens" on the first charge and closes `hours` after it; a
  // closed window's spend reads as zero and the next charge opens a new one.
  //
  // Counters rather than a SUM over creditLedger on every admission: the hot path
  // must stay O(number of queued plans) indexed reads. rebuildWindowsSync()
  // recomputes this table from the ledger, so the counters are provable.
  userPlanWindows: {
    columns: {
      userPlanId: "TEXT NOT NULL",
      hours: "INTEGER NOT NULL",
      startedAt: "TEXT NOT NULL",
      spentNanoUsd: "INTEGER NOT NULL DEFAULT 0",
      updatedAt: "TEXT",
    },
    primaryKey: "PRIMARY KEY (userPlanId, hours)",
    indexes: [],
  },
  creditLedger: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      userId: "TEXT NOT NULL",
      userPlanId: "TEXT",
      apiKeyId: "TEXT",
      // usageHistory.id for `charge` rows: the request this money bought, which is
      // what lets the ledger page show the model and token counts.
      usageId: "INTEGER",
      // Idempotency key: one ledger row per request/charge.
      requestKey: "TEXT UNIQUE",
      deltaNanoUsd: "INTEGER NOT NULL",
      balanceAfterNanoUsd: "INTEGER",
      kind: "TEXT NOT NULL",
      meta: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_cl_user_ts ON creditLedger(userId, createdAt)",
      // rebuildWindowsSync and the per-plan ledger filter both walk one plan's
      // rows in time order.
      "CREATE INDEX IF NOT EXISTS idx_cl_userplan_ts ON creditLedger(userPlanId, createdAt)",
    ],
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
  // Time-limited discounts on the list price of models (spec model-discounts).
  // One row is one rule; rules that apply to the same request stack additively,
  // capped at 100%. See src/lib/billing/discounts.js for the matching rules.
  modelDiscounts: {
    columns: {
      id: "TEXT PRIMARY KEY",
      // 'combo' | 'plan' | 'group'
      scopeType: "TEXT NOT NULL",
      // combo: the combo NAME (the key combo prices use and the name a client
      // requests); plan: plans.id; group: keyGroups.id.
      scopeId: "TEXT NOT NULL",
      // JSON array of combo names the rule covers. NULL/[] = every model of the
      // scope (for a combo-scope rule: that combo). Always NULL for combo scope.
      models: "TEXT",
      // Discount in basis points (1..10000), an integer — never a float.
      percentBp: "INTEGER NOT NULL",
      // ISO instants. startsAt is inclusive, endsAt exclusive; NULL = open end.
      startsAt: "TEXT",
      endsAt: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      label: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_md_scope ON modelDiscounts(scopeType, scopeId)",
      "CREATE INDEX IF NOT EXISTS idx_md_window ON modelDiscounts(isActive, startsAt, endsAt)",
    ],
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
