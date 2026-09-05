//! Auth module — argon2 password verification, JWT cookies, RequireAdmin guard.

pub mod password;
pub mod guards;

pub use guards::{RequireAdmin, AdminClaims, issue_token, verify_token, verify_dashboard_password, extract_token, ADMIN_COOKIE_NAME};
pub use password::{hash_password, verify_password};
