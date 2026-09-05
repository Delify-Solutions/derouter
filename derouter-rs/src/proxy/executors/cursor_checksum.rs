//! Cursor Checksum Utility (Jyh Cipher)
//!
//! Rust port of open-sse/utils/cursorChecksum.js.
//! Generates the x-cursor-checksum header required for Cursor API authentication.

use sha2::{Digest, Sha256};
use uuid::Uuid;

/// DNS namespace UUID for UUID v5: 6ba7b810-9dad-11d1-80b4-00c04fd430c8
const DNS_NAMESPACE: Uuid = Uuid::from_bytes([
    0x6b, 0xa7, 0xb8, 0x10,
    0x9d, 0xad,
    0x11, 0xd1,
    0x80, 0xb4,
    0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
]);

/// URL-safe base64 alphabet used by the Jyh cipher (no padding).
const B64_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Generate SHA-256 hash as a 64-character hex string.
///
/// Port of `generateHashed64Hex(input, salt)` from cursorChecksum.js.
/// Computes SHA256(input + salt) and returns the hex digest.
pub fn generate_hashed64_hex(input: &str, salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hasher.update(salt.as_bytes());
    let result = hasher.finalize();
    // Format as hex string (lowercase, 64 chars)
    let mut hex = String::with_capacity(64);
    for byte in result.iter() {
        hex.push_str(&format!("{:02x}", byte));
    }
    hex
}

/// Generate session ID using UUID v5 with the DNS namespace.
///
/// Port of `generateSessionId(authToken)` from cursorChecksum.js.
/// The DNS namespace UUID is 6ba7b810-9dad-11d1-80b4-00c04fd430c8.
pub fn generate_session_id(auth_token: &str) -> String {
    Uuid::new_v5(&DNS_NAMESPACE, auth_token.as_bytes()).to_string()
}

/// Generate cursor checksum using the Jyh cipher.
///
/// Port of `generateCursorChecksum(machineId)` from cursorChecksum.js.
///
/// Algorithm:
/// 1. timestamp = floor(now_ms / 1_000_000) — 6 bytes big-endian
/// 2. XOR each byte with key (starting 165), then byte = (byte ^ key + i) & 0xFF; key = byte
/// 3. URL-safe base64 encode (custom alphabet, no padding, 3-byte groups with truncation)
/// 4. Return {encoded}{machine_id}
pub fn generate_cursor_checksum(machine_id: &str) -> String {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0) as u64;
    let timestamp = now_ms / 1_000_000;

    // 6 bytes big-endian
    let mut byte_array = [
        ((timestamp >> 40) & 0xFF) as u8,
        ((timestamp >> 32) & 0xFF) as u8,
        ((timestamp >> 24) & 0xFF) as u8,
        ((timestamp >> 16) & 0xFF) as u8,
        ((timestamp >> 8) & 0xFF) as u8,
        (timestamp & 0xFF) as u8,
    ];

    // Jyh cipher obfuscation
    // JS: byteArray[i] = ((byteArray[i] ^ t) + (i % 256)) & 0xFF; t = byteArray[i];
    let mut t: u8 = 165;
    for i in 0..byte_array.len() {
        byte_array[i] = ((byte_array[i] ^ t).wrapping_add((i % 256) as u8)) & 0xFF;
        t = byte_array[i];
    }

    // URL-safe base64 encode (without padding), 3-byte groups with truncation handling
    let encoded = url_safe_base64_no_pad(&byte_array);

    format!("{}{}", encoded, machine_id)
}

/// Custom URL-safe base64 encoder matching the JS implementation exactly.
/// Uses alphabet "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
/// and produces no padding. Processes 3-byte groups with truncation handling.
fn url_safe_base64_no_pad(data: &[u8]) -> String {
    let mut encoded = String::new();
    let mut i = 0;
    while i < data.len() {
        let a = data[i];
        let b = if i + 1 < data.len() { data[i + 1] } else { 0 };
        let c = if i + 2 < data.len() { data[i + 2] } else { 0 };

        encoded.push(B64_ALPHABET[(a >> 2) as usize] as char);
        encoded.push(B64_ALPHABET[(((a & 3) << 4) | (b >> 4)) as usize] as char);

        if i + 1 < data.len() {
            encoded.push(B64_ALPHABET[(((b & 15) << 2) | (c >> 6)) as usize] as char);
        }
        if i + 2 < data.len() {
            encoded.push(B64_ALPHABET[(c & 63) as usize] as char);
        }

        i += 3;
    }
    encoded
}

/// Build the full set of Cursor API headers.
///
/// Port of `buildCursorHeaders(accessToken, machineId, ghostMode)` from cursorChecksum.js.
///
/// # Deviations from JS
/// - Timezone: Rust std has no Intl API. We use "UTC" as a safe default.
///   The JS version uses `Intl.DateTimeFormat().resolvedOptions().timeZone`.
/// - OS detection uses `std::env::consts::OS` (maps "macos"->"macos", "windows"->"windows", else "linux")
/// - Architecture uses `std::env::consts::ARCH` (maps "aarch64"->"aarch64", else "x64")
pub fn build_cursor_headers(
    access_token: &str,
    machine_id: Option<&str>,
    ghost_mode: bool,
) -> Vec<(String, String)> {
    // Clean token if it has "WorkosCursorSessionToken::" prefix or similar "::" delimiter
    let clean_token = if let Some(idx) = access_token.find("::") {
        &access_token[idx + 2..]
    } else {
        access_token
    };

    // Generate machine ID if not provided
    let effective_machine_id = machine_id
        .map(|s| s.to_string())
        .unwrap_or_else(|| generate_hashed64_hex(clean_token, "machineId"));

    // Generate derived values
    let session_id = generate_session_id(clean_token);
    let client_key = generate_hashed64_hex(clean_token, "");
    let checksum = generate_cursor_checksum(&effective_machine_id);

    // Detect OS
    let os = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };

    // Detect architecture
    let arch = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        _ => "x64",
    };

    // Generate random UUIDs for various headers
    let trace_id = Uuid::new_v4();
    let config_version = Uuid::new_v4();
    let request_id = Uuid::new_v4();

    vec![
        ("authorization".to_string(), format!("Bearer {}", clean_token)),
        ("connect-accept-encoding".to_string(), "gzip".to_string()),
        ("connect-protocol-version".to_string(), "1".to_string()),
        ("content-type".to_string(), "application/connect+proto".to_string()),
        ("user-agent".to_string(), "connect-es/1.6.1".to_string()),
        ("x-amzn-trace-id".to_string(), format!("Root={}", trace_id)),
        ("x-client-key".to_string(), client_key),
        ("x-cursor-checksum".to_string(), checksum),
        ("x-cursor-client-version".to_string(), "3.12.17".to_string()),
        ("x-cursor-client-commit".to_string(), "0fb762053c34788bb7760d5673f8a6d4c8589d50".to_string()),
        ("x-cursor-client-type".to_string(), "ide".to_string()),
        ("x-cursor-client-os".to_string(), os.to_string()),
        ("x-cursor-client-arch".to_string(), arch.to_string()),
        ("x-cursor-client-device-type".to_string(), "desktop".to_string()),
        ("x-cursor-config-version".to_string(), config_version.to_string()),
        // Deviation: Rust std has no Intl API; use "UTC" as safe default.
        ("x-cursor-timezone".to_string(), "UTC".to_string()),
        ("x-ghost-mode".to_string(), if ghost_mode { "true".to_string() } else { "false".to_string() }),
        ("x-request-id".to_string(), request_id.to_string()),
        ("x-session-id".to_string(), session_id),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hashed64_hex_known_value() {
        // Verify against a known SHA256 value
        let result = generate_hashed64_hex("test", "");
        assert_eq!(result.len(), 64);
        assert_eq!(result, "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
    }

    #[test]
    fn test_hashed64_hex_with_salt() {
        let result = generate_hashed64_hex("test", "machineId");
        assert_eq!(result.len(), 64);
    }

    #[test]
    fn test_session_id_deterministic() {
        let id1 = generate_session_id("my-token");
        let id2 = generate_session_id("my-token");
        assert_eq!(id1, id2);
        // Verify it's a valid UUID format
        assert!(Uuid::parse_str(&id1).is_ok());
    }

    #[test]
    fn test_session_id_known_value() {
        // UUID v5 with DNS namespace is deterministic; verify format only.
        let id = generate_session_id("test");
        assert!(Uuid::parse_str(&id).is_ok());
    }

    #[test]
    fn test_cursor_checksum_format() {
        let checksum = generate_cursor_checksum("test-machine-id");
        assert!(checksum.ends_with("test-machine-id"));
        // The base64 part should be 8 chars for 6 input bytes
        let b64_part = &checksum[..checksum.len() - "test-machine-id".len()];
        assert_eq!(b64_part.len(), 8);
    }

    #[test]
    fn test_build_cursor_headers() {
        let headers = build_cursor_headers("my-token", Some("machine-123"), false);
        assert_eq!(headers.len(), 19);
        // Check authorization header
        let auth = headers.iter().find(|(k, _)| k == "authorization").unwrap();
        assert_eq!(auth.1, "Bearer my-token");
        // Check ghost mode is false
        let ghost = headers.iter().find(|(k, _)| k == "x-ghost-mode").unwrap();
        assert_eq!(ghost.1, "false");
        // Check checksum ends with machine id
        let checksum = headers.iter().find(|(k, _)| k == "x-cursor-checksum").unwrap();
        assert!(checksum.1.ends_with("machine-123"));
    }

    #[test]
    fn test_clean_token_with_prefix() {
        let headers = build_cursor_headers("WorkosCursorSessionToken::abc123", None, true);
        let auth = headers.iter().find(|(k, _)| k == "authorization").unwrap();
        assert_eq!(auth.1, "Bearer abc123");
    }
}
