// Generator: emits derouter-rs/src/providers/registry/apikey.rs from the Node registry source.
// Reads each apikey-category JS registry entry and produces a Rust const array entry
// matching the ProviderRegistryEntry struct shape used by oauth.rs/free_tier.rs.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const regDir = join(__dirname, "..", "open-sse", "providers", "registry");

// rs (rust) string escaping: escape \ and " and newlines stay as \n
function rsStr(s) {
  if (s === undefined || s === null) return "None";
  const escaped = String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `Some("${escaped}")`;
}

function rsArr(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "&[]";
  const items = arr.map((x) => `"${String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `&[${items.join(", ")}]`;
}

// headers: array of [k,v] or {key,value} — Node uses headers array of pairs usually
function rsHeaders(h) {
  if (!h || !Array.isArray(h) || h.length === 0) return "&[]";
  const items = h.map((pair) => {
    if (Array.isArray(pair)) {
      return `("${String(pair[0]).replace(/"/g, '\\"')}", "${String(pair[1]).replace(/"/g, '\\"')}")`;
    } else if (pair && typeof pair === "object") {
      return `("${String(pair.key || pair.name || "").replace(/"/g, '\\"')}", "${String(pair.value || pair.value || "").replace(/"/g, '\\"')}")`;
    }
    return null;
  }).filter(Boolean);
  return `&[${items.join(", ")}]`;
}

function rsModels(models) {
  if (!models || !Array.isArray(models) || models.length === 0) return "&[]";
  const items = models.map((m) => {
    const id = String(m.id || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const name = String(m.name || m.id || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const kind = m.kind ? `Some("${String(m.kind).replace(/"/g, '\\"')}")` : "None";
    return `ProviderModel { id: "${id}", name: "${name}", kind: ${kind} }`;
  });
  return `&[${items.join(", ")}]`;
}

function rsDisplay(display) {
  const d = display || {};
  const notice = d.notice ? `Some(ProviderNotice {
            api_key_url: ${rsStr(d.notice.apiKeyUrl || d.notice.api_key_url)},
            signup_url: ${rsStr(d.notice.signupUrl || d.notice.signup_url)},
            text: ${rsStr(d.notice.text)},
            deprecated: ${d.notice.deprecated ? "Some(true)" : "None"},
            deprecation_notice: ${rsStr(d.notice.deprecationNotice || d.notice.deprecation_notice)},
        })` : "None";
  return `ProviderDisplay {
            name: "${String(d.name || "").replace(/"/g, '\\"')}",
            icon: ${rsStr(d.icon)},
            color: ${rsStr(d.color)},
            text_icon: ${rsStr(d.textIcon || d.text_icon)},
            website: ${rsStr(d.website)},
            notice: ${notice},
        }`;
}

function rsTransport(t) {
  const tr = t || {};
  const auth = tr.auth ? `Some(ProviderAuth {
                combined: ${!!tr.auth.combined},
                header: "${String(tr.auth.header || "").replace(/"/g, '\\"')}",
                scheme: "${String(tr.auth.scheme || "").replace(/"/g, '\\"')}",
            })` : "None";
  let extra = "";
  if (tr.forceStream !== undefined) extra += `, force_stream: ${tr.forceStream ? "Some(true)" : "Some(false)"}`;
  if (tr.clientVersion) extra += `, client_version: ${rsStr(tr.clientVersion)}`;
  if (tr.chatPath) extra += `, chat_path: ${rsStr(tr.chatPath)}`;
  return `ProviderTransport {
            base_url: ${rsStr(tr.baseUrl || tr.base_url)},
            format: ${rsStr(tr.format)},
            url_suffix: ${rsStr(tr.urlSuffix || tr.url_suffix)},
            headers: ${rsHeaders(tr.headers)},
            auth: ${auth}${extra},
            ..DEFAULT_TRANSPORT
        }`;
}

function rsCategory(cat) {
  const map = {
    apikey: "ProviderCategory::Apikey",
    oauth: "ProviderCategory::Oauth",
    webCookie: "ProviderCategory::WebCookie",
    "web-cookie": "ProviderCategory::WebCookie",
    freeTier: "ProviderCategory::FreeTier",
    free: "ProviderCategory::Free",
    compatible: "ProviderCategory::Compatible",
    embedding: "ProviderCategory::Embedding",
    media: "ProviderCategory::Media",
  };
  return map[cat] || "ProviderCategory::Apikey";
}

// apikey-category files only
const allFiles = readdirSync(regDir).filter((f) => f.endsWith(".js") && f !== "index.js");
const apikeyFiles = [];
for (const f of allFiles) {
  const mod = await import(join(regDir, f));
  const entry = mod.default;
  if (entry && entry.category === "apikey") apikeyFiles.push({ file: f, entry });
}

// sort by priority then id for stable output
apikeyFiles.sort((a, b) => (a.entry.priority || 0) - (b.entry.priority || 0) || a.entry.id.localeCompare(b.entry.id));

let out = `//! APIKEY category providers (${apikeyFiles.length} entries).
//! Auto-generated from open-sse/providers/registry/*.js (category: "apikey").
//! Do not edit by hand — re-run scripts/gen_apikey_registry.mjs to regenerate.

use super::*;

pub static ENTRIES: &[ProviderRegistryEntry] = &[
`;

for (const { file, entry: e } of apikeyFiles) {
  out += `    // src: ${file}
    ProviderRegistryEntry {
        id: "${String(e.id || "").replace(/"/g, '\\"')}",
        priority: ${e.priority ?? 0},
        alias: "${String(e.alias || "").replace(/"/g, '\\"')}",
        ui_alias: ${rsStr(e.uiAlias || e.ui_alias)},
        display: ${rsDisplay(e.display)},
        category: ${rsCategory(e.category)},
        transport: ${rsTransport(e.transport)},
        models: ${rsModels(e.models)},
        service_kinds: ${rsArr(e.serviceKinds || e.service_kinds)},
        hidden: ${!!e.hidden},
    },
`;
}

out += "];\n";

const outFile = join(__dirname, "..", "derouter-rs", "src", "providers", "registry", "apikey.rs");
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, out);
console.log(`Wrote ${outFile}`);
console.log(`Entries: ${apikeyFiles.length}`);
console.log(`Files: ${apikeyFiles.map((x) => x.file).join(", ")}`);
