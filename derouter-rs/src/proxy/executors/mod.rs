//! Provider executors.
//! Core executors: openai, anthropic, openai_compat, google, azure, ollama.
//! Group 3 executors: xiaomi_tokenplan, codebuddy_intl, codebuddy_cn, gemini_cli,
//! iflow, opencode, kimchi, mimo_free, vertex, zed.
//! Group 3 batch B executors: grok_web, github, perplexity_web, grok_cli,
//! qoder, windsurf, antigravity, devin_cli.

pub mod base;
pub mod openai;
pub mod anthropic;
pub mod openai_compat;
pub mod google;
pub mod azure;
pub mod ollama;
pub mod cursor_proto;
pub mod cursor_checksum;
pub mod cursor;
pub mod kiro;
pub mod kiro_token;
pub mod codex;
pub mod xiaomi_tokenplan;
pub mod codebuddy_intl;
pub mod codebuddy_cn;
pub mod gemini_cli;
pub mod iflow;
pub mod commandcode;
pub mod opencode;
pub mod kimchi;
pub mod mimo_free;
pub mod vertex;
pub mod zed;
pub mod grok_web;
pub mod github;
pub mod perplexity_web;
pub mod grok_cli;
pub mod qoder;
pub mod windsurf;
pub mod antigravity;
pub mod devin_cli;

// Re-export executor structs for use in select_executor
#[allow(unused_imports)]
pub use xiaomi_tokenplan::XiaomiTokenplanExecutor;
#[allow(unused_imports)]
pub use codebuddy_intl::CodebuddyIntlExecutor;
#[allow(unused_imports)]
pub use codebuddy_cn::CodebuddyCnExecutor;
#[allow(unused_imports)]
pub use gemini_cli::GeminiCliExecutor;
#[allow(unused_imports)]
pub use iflow::IFlowExecutor;
#[allow(unused_imports)]
pub use commandcode::CommandCodeExecutor;
#[allow(unused_imports)]
pub use opencode::OpenCodeExecutor;
#[allow(unused_imports)]
pub use kimchi::KimchiExecutor;
#[allow(unused_imports)]
pub use mimo_free::MimoFreeExecutor;
#[allow(unused_imports)]
pub use vertex::VertexExecutor;
#[allow(unused_imports)]
pub use zed::ZedExecutor;
#[allow(unused_imports)]
pub use grok_web::GrokWebExecutor;
#[allow(unused_imports)]
pub use github::GithubExecutor;
#[allow(unused_imports)]
pub use perplexity_web::PerplexityWebExecutor;
#[allow(unused_imports)]
pub use grok_cli::GrokCliExecutor;
#[allow(unused_imports)]
pub use qoder::QoderExecutor;
#[allow(unused_imports)]
pub use windsurf::WindsurfExecutor;
#[allow(unused_imports)]
pub use antigravity::AntigravityExecutor;
#[allow(unused_imports)]
pub use devin_cli::DevinCliExecutor;
#[allow(unused_imports)]
pub use cursor::CursorExecutor;
#[allow(unused_imports)]
pub use kiro::KiroExecutor;
#[allow(unused_imports)]
pub use codex::CodexExecutor;
