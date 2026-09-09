//! Pure-Rust logging integrations. Names map 1:1 to Python
//! `derouter/integrations/`:
//!   - [`custom_guardrail::CustomGuardrail`] — the guardrail callback trait
//!   - [`custom_logger::CustomLogger`]  — the callback trait
//!   - [`derouter_python_proxy_api::DeRouterPythonProxyAPILogger`] — ships events
//!     to the Python proxy's `/v1/rust_control_plane/logs` endpoint
//!   - [`types`] — the typed `StandardLoggingPayload` wire contract

pub mod custom_guardrail;
pub mod custom_logger;
pub mod derouter_python_proxy_api;
pub mod types;
