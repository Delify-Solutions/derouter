import { loadState, saveState, generateShortId } from "../shared/state.js";
import { spawnQuickTunnel, killCloudflared, isCloudflaredRunning, setUnexpectedExitHandler } from "./cloudflared.js";
import { clearPid } from "./pid.js";
import { waitForHealth, probeUrlAlive } from "./healthCheck.js";
import { WORKER_URL } from "./config.js";
import { getSettings, updateSettings } from "@/lib/localDb";

const svc = {
  cancelToken: { cancelled: false },
  spawnInProgress: false,
  lastRestartAt: 0,
  activeLocalPort: null,
};

export function getTunnelService() { return svc; }
export function isTunnelManuallyDisabled() { return svc.cancelToken.cancelled; }
export function isTunnelReconnecting() { return svc.spawnInProgress; }

let onUnexpectedExit = null;
export function setTunnelUnexpectedExitCallback(cb) { onUnexpectedExit = cb; }

async function registerTunnelUrl(shortId, tunnelUrl) {
  await fetch(`${WORKER_URL}/api/tunnel/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shortId, tunnelUrl })
  });
}

function throwIfCancelled(token) {
  if (token.cancelled) throw new Error("tunnel cancelled");
}

export async function enableTunnel(localPort = 20128) {
  svc.cancelToken = { cancelled: false };
  svc.activeLocalPort = localPort;
  svc.spawnInProgress = true;
  const token = svc.cancelToken;

  try {
    if (isCloudflaredRunning()) {
      const existing = loadState();
      if (existing?.tunnelUrl && existing?.shortId) {
        const publicUrl = `https://r${existing.shortId}.abc-tunnel.us`;
        // Reuse only if BOTH direct + public URL alive (avoid stale socket after network change)
        const [directOk, publicOk] = await Promise.all([
          probeUrlAlive(existing.tunnelUrl),
          probeUrlAlive(publicUrl),
        ]);
        if (directOk && publicOk) {
          return { success: true, tunnelUrl: existing.tunnelUrl, shortId: existing.shortId, publicUrl, alreadyRunning: true };
        }
      }
    }

    killCloudflared(localPort);
    throwIfCancelled(token);

    const existing = loadState();
    const shortId = existing?.shortId || generateShortId();

    const onUrlUpdate = async (url) => {
      if (token.cancelled) return;
      await registerTunnelUrl(shortId, url);
      saveState({ shortId, tunnelUrl: url });
      await updateSettings({ tunnelEnabled: true, tunnelUrl: url });
    };

    // Register exit handler BEFORE spawn so it fires even on early exit
    setUnexpectedExitHandler(() => {
      console.warn("[Tunnel] cloudflared exited unexpectedly, scheduling respawn");
      if (onUnexpectedExit) onUnexpectedExit();
    });

    const { tunnelUrl } = await spawnQuickTunnel(localPort, onUrlUpdate);
    throwIfCancelled(token);

    const publicUrl = `https://r${shortId}.abc-tunnel.us`;
    await registerTunnelUrl(shortId, tunnelUrl);
    saveState({ shortId, tunnelUrl });
    await updateSettings({ tunnelEnabled: true, tunnelUrl });

    // Verify publicUrl first (worker route is reliable; direct *.trycloudflare.com DNS may lag)
    await waitForHealth(publicUrl, token);
    // Direct tunnel probe is best-effort: DNS for *.trycloudflare.com can be slow/blocked
    if (!(await probeUrlAlive(tunnelUrl))) {
      console.warn("[Tunnel] direct URL not reachable yet, continuing via publicUrl");
    } else {
    }

    return { success: true, tunnelUrl, shortId, publicUrl };
  } catch (e) {
    // Suppress noise when spawn was deliberately killed (restart/disable superseded it)
    if (!/cloudflared killed|tunnel cancelled/.test(e.message)) {
      console.error(`[Tunnel] enable error: ${e.message}`);
    }
    throw e;
  } finally {
    svc.spawnInProgress = false;
  }
}

export async function disableTunnel() {
  // Abort any in-flight enable so it cannot resurrect state after we clear it
  svc.cancelToken.cancelled = true;
  setUnexpectedExitHandler(null);

  try { killCloudflared(svc.activeLocalPort); } catch (e) { console.warn(`[Tunnel] kill warn: ${e.message}`); }
  clearPid();

  const state = loadState();
  if (state) saveState({ shortId: state.shortId, tunnelUrl: null });

  await updateSettings({ tunnelEnabled: false, tunnelUrl: "" });
  // Force-clear flags so a subsequent enable is not blocked by a stuck spawnInProgress
  svc.spawnInProgress = false;
  svc.activeLocalPort = null;
  return { success: true };
}

export async function getTunnelStatus() {
  const settings = await getSettings();
  const settingsEnabled = settings.tunnelEnabled === true;
  const state = loadState();
  const shortId = state?.shortId || "";
  const publicUrl = shortId ? `https://r${shortId}.abc-tunnel.us` : "";
  const tunnelUrl = state?.tunnelUrl || "";

  // Lazy: skip PID probe entirely when user disabled tunnel
  const running = settingsEnabled ? isCloudflaredRunning() : false;

  return {
    enabled: settingsEnabled && running,
    settingsEnabled,
    tunnelUrl,
    shortId,
    publicUrl,
    running
  };
}
