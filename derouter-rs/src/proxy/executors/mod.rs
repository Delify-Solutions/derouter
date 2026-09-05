//! Provider executors — Phase 1.
//! 6 core executors: openai, anthropic, openai_compat, google, azure, ollama.

pub mod base;
pub mod openai;
pub mod anthropic;
pub mod openai_compat;
pub mod google;
pub mod azure;
pub mod ollama;
