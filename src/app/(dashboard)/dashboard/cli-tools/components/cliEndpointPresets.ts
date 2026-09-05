import { UPDATER_CONFIG } from "@/shared/constants/config";
import type { EndpointPreset, KeyPreset } from "./cliTools.types";

interface StoreItem {
  name: string;
}

interface Store<Item extends StoreItem> {
  storageKey: string;
  changeEvent: string;
  itemField: string;
  normalize?: (v: string) => string;
  defaultName?: (v: string) => string;
}

// Browser-local preset stores (endpoints, API keys) shared by every CLI tool card
function createStore<Item extends StoreItem, C extends Store<Item> & { itemField: keyof Item & string }>(config: C) {
  const { storageKey, changeEvent, itemField, normalize = (v: string) => v, defaultName = (v: string) => v } = config;

  const read = (): Item[] => {
    if (typeof window === "undefined") return [];
    try {
      const raw = JSON.parse(window.localStorage.getItem(storageKey) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw.filter((p: Item) => p?.name && p?.[itemField]);
    } catch {
      return [];
    }
  };

  const write = (items: Item[]): void => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKey, JSON.stringify(items));
    window.dispatchEvent(new CustomEvent(changeEvent));
  };

  return {
    read,
    subscribe: (handler: () => void): (() => void) => {
      if (typeof window === "undefined") return () => {};
      window.addEventListener(changeEvent, handler);
      return () => window.removeEventListener(changeEvent, handler);
    },
    // Adds or replaces a preset; returns the stored name, or null when skipped
    upsert: (value: string, name?: string): string | null => {
      const v = normalize(value);
      if (!v) return null;

      const items = read();
      const existing = items.find((p) => normalize(String(p[itemField])) === v);
      if (existing && !name) return existing.name;

      const finalName = (name || defaultName(v)).trim();
      if (!finalName) return null;

      const next = [
        ...items.filter((p) => p.name !== finalName && normalize(String(p[itemField])) !== v),
        { name: finalName, [itemField]: v } as unknown as Item,
      ].sort((a, b) => a.name.localeCompare(b.name));
      write(next);
      return finalName;
    },
    remove: (name: string): void => write(read().filter((p) => p.name !== name)),
  };
}

const stripSlash = (url: string): string => (url || "").replace(/\/+$/, "");

type EndpointStoreItem = EndpointPreset & { baseUrl: string };
const endpoints = createStore<EndpointStoreItem, Store<EndpointStoreItem> & { itemField: "baseUrl" }>({
  storageKey: "derouter.cliToolEndpointPresets",
  changeEvent: "derouter:endpoint-presets-changed",
  itemField: "baseUrl",
  normalize: stripSlash,
  defaultName: (url: string) => {
    try { return new URL(url).host; } catch { return url; }
  },
});

type KeyStoreItem = KeyPreset & { key: string };
const apiKeys = createStore<KeyStoreItem, Store<KeyStoreItem> & { itemField: "key" }>({
  storageKey: "derouter.cliToolApiKeyPresets",
  changeEvent: "derouter:api-key-presets-changed",
  itemField: "key",
});

export const readPresets: () => EndpointPreset[] = endpoints.read as () => EndpointPreset[];
export const subscribePresets = endpoints.subscribe;
export const upsertPreset = endpoints.upsert;
export const deletePreset = endpoints.remove;

export const readKeyPresets: () => KeyPreset[] = apiKeys.read as () => KeyPreset[];
export const subscribeKeyPresets = apiKeys.subscribe;
export const upsertKeyPreset = apiKeys.upsert;
export const deleteKeyPreset = apiKeys.remove;

interface RememberEndpointOpts {
  tunnelPublicUrl?: string | null;
  tailscaleUrl?: string | null;
  cloudUrl?: string | null;
}

// Save an applied endpoint unless it exactly matches a built-in dropdown option
export function rememberEndpoint(
  baseUrl: string,
  { tunnelPublicUrl, tailscaleUrl, cloudUrl }: RememberEndpointOpts = {},
): string | null {
  const url = stripSlash(baseUrl);
  if (!url) return null;

  const builtIns = [`http://127.0.0.1:${UPDATER_CONFIG.appPort}`, tunnelPublicUrl, tailscaleUrl, cloudUrl]
    .filter(Boolean)
    .flatMap((u) => [stripSlash(String(u)), `${stripSlash(String(u))}/v1`]);
  if (builtIns.includes(url)) return null;

  return upsertPreset(url);
}

export { stripSlash };
