"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Badge, Input, Toast, Modal } from "@/shared/components";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";

/**
 * Shared MITM infrastructure card — manages SSL cert + server start/stop.
 * DNS per-tool is handled separately in MitmToolCard.
 */
export default function MitmServerCard({ apiKeys, cloudEnabled, onStatusChange }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [sudoPassword, setSudoPassword] = useState("");
  const [selectedApiKey, setSelectedApiKey] = useState(() => apiKeys?.[0]?.key || "");
  const [pendingAction, setPendingAction] = useState(null);
  const [modalError, setModalError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [mitmRouterBaseUrl, setMitmRouterBaseUrl] = useState(DEFAULT_MITM_ROUTER_BASE);
  const [port443Conflict, setPort443Conflict] = useState(null);

  const serverIsWindows = status?.isWin === true;
  const canRunWithoutPassword = serverIsWindows || status?.hasCachedPassword || status?.needsSudoPassword === false;
  const isAdmin = status?.isAdmin !== false;
  // No privilege: not admin/root AND (Win OR no cached sudo password)
  const noPrivilege = !isAdmin && (serverIsWindows || (!status?.hasCachedPassword && status?.needsSudoPassword !== false));

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/cli-tools/antigravity-mitm");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        if (data.mitmRouterBaseUrl) {
          setMitmRouterBaseUrl(data.mitmRouterBaseUrl);
        }
        onStatusChange?.(data);
      }
    } catch {
      setStatus({ running: false, certExists: false, dnsStatus: {} });
    }
  }, [onStatusChange]);

  useEffect(() => {
    queueMicrotask(() => {
      fetchStatus();
    });
  }, [fetchStatus]);

  const handleAction = (action) => {
    setActionError(null);
    // Wait for status to load before deciding whether to show sudo modal
    if (!status) return;
    if (canRunWithoutPassword) {
      doAction(action, "");
    } else {
      setPendingAction(action);
      setShowPasswordModal(true);
      setModalError(null);
    }
  };

  const doAction = async (action, password, forceKillPort443 = false) => {
    setLoading(true);
    setActionError(null);
    try {
      let res;
      if (action === "trust-cert") {
        res = await fetch("/api/cli-tools/antigravity-mitm", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "trust-cert", sudoPassword: password }),
        });
      } else if (action === "start") {
        const keyToUse = selectedApiKey?.trim()
          || (apiKeys?.length > 0 ? apiKeys[0].key : null)
          || (!cloudEnabled ? "sk_derouter" : null);
        res = await fetch("/api/cli-tools/antigravity-mitm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey: keyToUse,
            sudoPassword: password,
            mitmRouterBaseUrl: mitmRouterBaseUrl.trim() || DEFAULT_MITM_ROUTER_BASE,
            forceKillPort443,
          }),
        });
      } else {
        res = await fetch("/api/cli-tools/antigravity-mitm", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sudoPassword: password }),
        });
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.code === "PORT_443_BUSY" && data.portOwner) {
          setShowPasswordModal(false);
          setPort443Conflict({ owner: data.portOwner, password });
          return;
        }
        setActionError(data.error || `Failed to ${action} MITM server`);
        return;
      }
      setShowPasswordModal(false);
      setSudoPassword("");
      setPort443Conflict(null);
      await fetchStatus();
    } catch (e) {
      setActionError(e.message || "Network error");
    } finally {
      setLoading(false);
      setPendingAction(null);
    }
  };

  const handleKillAndStart = () => {
    const pwd = port443Conflict?.password || "";
    doAction("start", pwd, true);
  };

  const handleConfirmPassword = () => {
    if (!sudoPassword.trim()) {
      setModalError("Sudo password is required");
      return;
    }
    doAction(pendingAction, sudoPassword);
  };

  const isRunning = status?.running;

  return (
    <>
      <Card padding="sm" className="border border-vx-primary/20 bg-vx-primary/5">
        <div className="flex flex-col gap-3">
          {/* Header */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="material-symbols-outlined text-vx-primary text-[20px]">security</span>
              <span className="font-semibold text-sm text-vx-text">MITM Server</span>
              {isRunning ? (
                <Badge variant="success" size="sm">Running</Badge>
              ) : (
                <Badge variant="default" size="sm">Stopped</Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1" data-i18n-skip="true">
              {[
                { label: "Cert", ok: status?.certExists },
                { label: "Trusted", ok: status?.certTrusted },
                { label: "Server", ok: isRunning },
              ].map(({ label, ok }) => (
                <Badge key={label} variant={ok ? "success" : "default"} size="xs" icon={ok ? "check_circle" : "cancel"}>
                  {label}
                </Badge>
              ))}
            </div>
          </div>

          {/* Purpose & How it works */}
          <div className="px-2 py-2 rounded-vx-md bg-vx-surface/50 border border-vx-border/50 flex flex-col gap-2">
            <p className="text-[11px] text-vx-text-muted leading-relaxed">
              <span className="font-medium text-vx-text">Purpose:</span> Use Antigravity IDE & GitHub Copilot → with ANY provider/model from derouter
            </p>
            <p className="text-[11px] text-vx-text-muted leading-relaxed">
              <span className="font-medium text-vx-text">How it works:</span> Antigravity/Copilot IDE request → DNS redirect to localhost:443 → MITM proxy intercepts → derouter → response to Antigravity/Copilot
            </p>
          </div>

          {/* Base URL + API Key — same row pattern as Claude Code / cli-tools */}
          <div className="flex flex-col gap-2">
            <div className="grid gap-1 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
              <span className="text-xs font-semibold text-vx-text sm:text-right sm:text-sm">derouter Base URL</span>
              <span className="material-symbols-outlined hidden text-vx-text-muted text-[14px] sm:inline">arrow_forward</span>
              <Input
                value={mitmRouterBaseUrl}
                onChange={(e) => setMitmRouterBaseUrl(e.target.value)}
                placeholder={DEFAULT_MITM_ROUTER_BASE}
                disabled={isRunning}
                inputClassName="text-xs py-1.5"
              />
            </div>
            {!isRunning && (
              <div className="grid gap-1 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                <span className="text-xs font-semibold text-vx-text sm:text-right sm:text-sm">API Key</span>
                <span className="material-symbols-outlined hidden text-vx-text-muted text-[14px] sm:inline">arrow_forward</span>
                <Input
                  list="mitm-api-keys"
                  value={selectedApiKey}
                  onChange={(e) => setSelectedApiKey(e.target.value)}
                  placeholder={cloudEnabled ? "Enter or pick API key" : "sk_derouter (default)"}
                  inputClassName="text-xs py-1.5"
                />
                {apiKeys?.length > 0 && (
                  <datalist id="mitm-api-keys">
                    {apiKeys.map((key) => (
                      <option key={key.id} value={key.key}>{key.name || key.key}</option>
                    ))}
                  </datalist>
                )}
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center" data-i18n-skip="true">
            {status?.certExists && !status?.certTrusted && (
              <Button
                variant="warning-outline"
                size="sm"
                onClick={() => handleAction("trust-cert")}
                disabled={loading}
                icon="verified_user"
                className="w-full sm:w-auto"
              >
                Trust Cert
              </Button>
            )}
            {isRunning ? (
              <Button
                variant="danger-outline"
                size="sm"
                onClick={() => handleAction("stop")}
                disabled={loading}
                icon="stop_circle"
                className="w-full sm:w-auto"
              >
                Stop Server
              </Button>
            ) : (
              <Button
                variant="primary-outline"
                size="sm"
                onClick={() => handleAction("start")}
                disabled={loading || !status || (serverIsWindows && !isAdmin)}
                title={serverIsWindows && !isAdmin ? "Administrator required" : undefined}
                icon="play_circle"
                className="w-full sm:w-auto"
              >
                Start Server
              </Button>
            )}
            {isRunning && (
              <p className="text-xs text-vx-text-muted">Enable DNS per tool below to activate interception</p>
            )}
          </div>

          {/* Action error */}
          {actionError && <Toast type="error" message={actionError} dismissible={false} />}

          {/* Windows admin warning */}
          {serverIsWindows && !isAdmin && (
            <Toast type="error" message="Administrator required — restart derouter as Administrator to use MITM" dismissible={false} />
          )}
        </div>
      </Card>

      {/* Password Modal */}
      <Modal
        isOpen={showPasswordModal}
        onClose={() => { setShowPasswordModal(false); setSudoPassword(""); setModalError(null); }}
        title="Sudo Password Required"
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => { setShowPasswordModal(false); setSudoPassword(""); setModalError(null); }} disabled={loading}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleConfirmPassword} loading={loading}>
              Confirm
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Toast type="warning" message="Required for SSL certificate and server startup" dismissible={false} />
          <Input
            type="password"
            placeholder="Enter sudo password"
            value={sudoPassword}
            onChange={(e) => setSudoPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !loading) handleConfirmPassword(); }}
          />
          {modalError && <Toast type="error" message={modalError} dismissible={false} />}
        </div>
      </Modal>

      {/* Port 443 Conflict Modal */}
      <Modal
        isOpen={!!port443Conflict}
        onClose={() => { setPort443Conflict(null); setLoading(false); }}
        title="Port 443 Already In Use"
        size="md"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => { setPort443Conflict(null); setLoading(false); }} disabled={loading}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleKillAndStart} loading={loading}>
              Kill & Start
            </Button>
          </>
        }
      >
        {port443Conflict && (
          <Toast
            type="warning"
            title="Port 443 is currently used by another process"
            message={`${port443Conflict.owner.name} (PID ${port443Conflict.owner.pid})\nKill this process to start MITM Server?`}
            dismissible={false}
          />
        )}
      </Modal>
    </>
  );
}
