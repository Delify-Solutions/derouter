//! Askama template definitions — compiled at build time.
//! Template files are in the `templates/` directory.
//! All template fields use simple types (String, bool, i64) — no method calls or closures
//! in template expressions (Askama has limited expression support).

use askama::Template;

/// Base layout wrapper — any full page can embed content into the layout
#[derive(Template)]
#[template(path = "layout.html")]
pub struct Layout {
    pub title: String,
    pub content: String,
}

/// Simple dashboard page (Phase 0 placeholder)
#[derive(Template)]
#[template(path = "dashboard.html")]
pub struct DashboardPage {
    pub content: String,
}

/// Login page
#[derive(Template)]
#[template(path = "auth/login.html")]
pub struct LoginPage {
    pub error: Option<String>,
}

/// Generic info page for Phase 0
#[derive(Template)]
#[template(path = "info.html")]
pub struct InfoPage {
    pub title: String,
    pub message: String,
}

// === View models for pre-computed display values ===

/// Provider connection view item (pre-computed for template)
#[derive(Clone)]
pub struct ProviderItem {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub auth_type: String,
    pub priority: String,
    pub is_active: bool,
}

/// Combo view item
#[derive(Clone)]
pub struct ComboItem {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub models_count: usize,
}

/// Key view item (pre-computed with masked key)
#[derive(Clone)]
pub struct KeyItem {
    pub id: String,
    pub name: String,
    pub masked_key: String,
    pub group: String,
    pub rpm: String,
    pub tpm: String,
    pub budget: String,
    pub is_active: bool,
}

/// Group view item
#[derive(Clone)]
pub struct GroupItem {
    pub id: String,
    pub name: String,
    pub rpm: String,
    pub tpm: String,
    pub budget: String,
    pub reset_window: String,
    pub is_active: bool,
}

/// Simple group option for select dropdowns
#[derive(Clone)]
pub struct GroupOption {
    pub id: String,
    pub name: String,
}

// === Template structs ===

/// Providers list page
#[derive(Template)]
#[template(path = "dashboard/providers/list.html")]
pub struct ProvidersListPage {
    pub items: Vec<ProviderItem>,
}

/// Provider form (modal) — create or edit
#[derive(Template)]
#[template(path = "dashboard/providers/form.html")]
pub struct ProviderForm {
    pub is_edit: String,
    pub connection_id: String,
    pub provider: String,
    pub connection_name: String,
    pub auth_type: String,
    pub base_url: String,
    pub priority: String,
    pub is_active: bool,
}

/// Provider row partial (for HTMX fragment responses)
#[derive(Template)]
#[template(path = "dashboard/providers/partials/row.html")]
pub struct ProviderRow {
    pub item: ProviderItem,
}

/// Combos list page
#[derive(Template)]
#[template(path = "dashboard/combos/list.html")]
pub struct CombosListPage {
    pub items: Vec<ComboItem>,
}

/// Combo form (modal) — create or edit
#[derive(Template)]
#[template(path = "dashboard/combos/form.html")]
pub struct ComboForm {
    pub is_edit: String,
    pub combo_id: String,
    pub name: String,
    pub kind: String,
    pub models_text: String,
}

/// Combo row partial
#[derive(Template)]
#[template(path = "dashboard/combos/partials/row.html")]
pub struct ComboRow {
    pub item: ComboItem,
}

/// Combo test result fragment
#[derive(Template)]
#[template(path = "dashboard/combos/test_result.html")]
pub struct ComboTestResult {
    pub success: bool,
    pub reply: String,
    pub error: String,
    pub latency_ms: u64,
}

/// Keys list page
#[derive(Template)]
#[template(path = "dashboard/keys/list.html")]
pub struct KeysListPage {
    pub items: Vec<KeyItem>,
}

/// Key form (modal) — create or edit
#[derive(Template)]
#[template(path = "dashboard/keys/form.html")]
pub struct KeyForm {
    pub is_edit: String,
    pub key_id: String,
    pub name: String,
    pub group_id: String,
    pub groups: Vec<GroupOption>,
    pub rpm: String,
    pub tpm: String,
    pub budget_usd: String,
    pub reset_window: String,
    pub expires_at: String,
    pub allowed_models: String,
    pub is_active: bool,
    pub new_key: String,
    pub show_key: bool,
}

/// Key row partial
#[derive(Template)]
#[template(path = "dashboard/keys/partials/row.html")]
pub struct KeyRow {
    pub item: KeyItem,
}

/// Groups list page
#[derive(Template)]
#[template(path = "dashboard/groups/list.html")]
pub struct GroupsListPage {
    pub items: Vec<GroupItem>,
}

/// Group form (modal) — create or edit
#[derive(Template)]
#[template(path = "dashboard/groups/form.html")]
pub struct GroupForm {
    pub is_edit: String,
    pub group_id: String,
    pub name: String,
    pub rpm: String,
    pub tpm: String,
    pub budget_usd: String,
    pub reset_window: String,
    pub allowed_models: String,
    pub is_active: bool,
}

/// Group row partial
#[derive(Template)]
#[template(path = "dashboard/groups/partials/row.html")]
pub struct GroupRow {
    pub item: GroupItem,
}

/// Pricing row for the pool pricing table
#[derive(Clone)]
pub struct PricingRow {
    pub provider: String,
    pub model: String,
    pub input: String,
    pub output: String,
    pub cached: String,
    pub reasoning: String,
    pub cache_creation: String,
}

/// Combo pricing row
#[derive(Clone)]
pub struct ComboPricingRow {
    pub name: String,
    pub input: String,
    pub output: String,
    pub cached: String,
    pub reasoning: String,
    pub cache_creation: String,
}

/// Pricing page
#[derive(Template)]
#[template(path = "dashboard/pricing/page.html")]
pub struct PricingPage {
    pub pool_pricing: Vec<PricingRow>,
    pub combo_pricing: Vec<ComboPricingRow>,
}

// === Phase 3: Usage dashboard ===

/// Usage page shell with Alpine tabs
#[derive(Template)]
#[template(path = "dashboard/usage/page.html")]
pub struct UsagePage;

/// Overview tab fragment
#[derive(Template)]
#[template(path = "dashboard/usage/overview_tab.html")]
pub struct OverviewTab {
    pub total_requests: i64,
    pub total_input: i64,
    pub total_output: i64,
    pub total_cost: String,
    pub active_keys: i64,
    pub active_combos: i64,
    pub active_providers: i64,
}

/// Keys tab fragment (contains filter form + table container)
#[derive(Template)]
#[template(path = "dashboard/usage/keys_tab.html")]
pub struct KeysTab {
    pub groups: Vec<GroupOption>,
}

/// Per-key usage row for the keys table
#[derive(Clone)]
pub struct UsageKeyRow {
    pub id: String,
    pub name: String,
    pub masked_key: String,
    pub group: String,
    pub rpm_limit: String,
    pub rpm_live: String,
    pub tpm_limit: String,
    pub tpm_live: String,
    pub budget_limit: String,
    pub budget_spent: String,
    pub budget_pct: i64,
    pub budget_over: bool,
    pub peak_tpm: i64,
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_tokens: i64,
    pub cost: String,
    pub models_count: i64,
    pub is_active: bool,
    pub expires_at: String,
}

/// Keys table tbody fragment
#[derive(Template)]
#[template(path = "dashboard/usage/keys_table.html")]
pub struct KeysTable {
    pub rows: Vec<UsageKeyRow>,
}

/// Per-model breakdown sub-row for a key
#[derive(Clone)]
pub struct ModelBreakdownRow {
    pub model: String,
    pub requests: i64,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cost: String,
}

/// Per-model expand row fragment
#[derive(Template)]
#[template(path = "dashboard/usage/key_models.html")]
pub struct KeyModels {
    pub models: Vec<ModelBreakdownRow>,
    pub total_requests: i64,
    pub total_input: i64,
    pub total_output: i64,
    pub total_cost: String,
}

/// Details tab fragment (contains filter form + table container)
#[derive(Template)]
#[template(path = "dashboard/usage/details_tab.html")]
pub struct DetailsTab {
    pub keys: Vec<GroupOption>,
}

/// Per-detail row for the details table
#[derive(Clone)]
pub struct DetailRow {
    pub id: String,
    pub timestamp: String,
    pub key_name: String,
    pub requested_model: String,
    pub resolved_model: String,
    pub provider: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost: String,
    pub is_error: bool,
    pub latency: String,
}

/// Details table tbody fragment
#[derive(Template)]
#[template(path = "dashboard/usage/details_table.html")]
pub struct DetailsTable {
    pub rows: Vec<DetailRow>,
}

/// Detail drawer fragment
#[derive(Template)]
#[template(path = "dashboard/usage/detail_drawer.html")]
pub struct DetailDrawer {
    pub timestamp: String,
    pub key_name: String,
    pub requested_model: String,
    pub resolved_model: String,
    pub provider: String,
    pub is_error: bool,
    pub latency: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_tokens: String,
    pub cost: String,
    pub redacted_request_headers: String,
    pub raw_request_headers_json: String,
    pub request_body: String,
    pub redacted_response_headers: String,
    pub raw_response_headers_json: String,
    pub response_body: String,
    pub error_message: String,
}

// === Phase 4: Public usage ===

/// Public usage page (key entry form)
#[derive(Template)]
#[template(path = "public/usage.html")]
pub struct PublicUsagePage;

/// Period preset option for the public receipts
#[derive(Clone)]
pub struct PeriodPreset {
    pub id: String,
    pub label: String,
    pub active: bool,
}

/// Public receipts fragment
#[derive(Template)]
#[template(path = "public/receipts.html")]
pub struct PublicReceipts {
    pub key: String,
    pub masked_key: String,
    pub name: String,
    pub group_name: String,
    pub is_active: bool,
    pub expires_at: String,
    pub budget_unlimited: bool,
    pub budget_spent: String,
    pub budget_limit: String,
    pub budget_pct: i64,
    pub reset_window: String,
    pub rpm_limit: String,
    pub rpm_live: String,
    pub tpm_limit: String,
    pub tpm_live: String,
    pub peak_tpm: i64,
    pub total_requests: i64,
    pub total_cost: String,
    pub total_tokens: i64,
    pub period: String,
    pub periods: Vec<PeriodPreset>,
    pub models: Vec<ModelBreakdownRow>,
    pub rows: Vec<PublicHistoryRow>,
    pub has_data: bool,
}

/// Public request history row
#[derive(Clone)]
pub struct PublicHistoryRow {
    pub id: String,
    pub timestamp: String,
    pub requested_model: String,
    pub status: String,
    pub is_error: bool,
    pub latency: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost: String,
}

/// Public receipt detail fragment
#[derive(Template)]
#[template(path = "public/receipt_detail.html")]
pub struct PublicReceiptDetail {
    pub timestamp: String,
    pub requested_model: String,
    pub status: String,
    pub is_error: bool,
    pub latency: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_tokens: i64,
    pub request_json: String,
    pub provider_request_json: String,
    pub provider_response_json: String,
    pub response_json: String,
}
