"use client";

import React, { useState, useCallback } from "react";
import OAuthModal from "./OAuthModal";
import KiroAuthModal from "./KiroAuthModal";
import KiroSocialOAuthModal from "./KiroSocialOAuthModal";

/**
 * Kiro OAuth Wrapper
 * Orchestrates between method selection, device code flow, and social login flow
 */

type AuthMethod = "builder-id" | "idc" | "social" | "import" | "import-cli-proxy" | "api-key" | null;

interface IdcConfig {
  startUrl?: string;
  region?: string;
}

interface SocialConfig {
  provider: string;
}

interface MethodConfig {
  startUrl?: string;
  region?: string;
  provider?: string;
}

interface KiroProviderInfo {
  name?: string;
  [key: string]: unknown;
}

export interface KiroOAuthWrapperProps {
  isOpen: boolean;
  providerInfo?: KiroProviderInfo;
  onSuccess?: () => void;
  onClose: () => void;
}

export default function KiroOAuthWrapper({ isOpen, providerInfo, onSuccess, onClose }: KiroOAuthWrapperProps) {
  const [authMethod, setAuthMethod] = useState<AuthMethod>(null);
  const [socialProvider, setSocialProvider] = useState<string | null>(null);
  const [idcConfig, setIdcConfig] = useState<IdcConfig | null>(null);

  const handleMethodSelect = useCallback((method: string, config?: MethodConfig): void => {
    if (method === "builder-id") {
      // Use device code flow (AWS Builder ID)
      setAuthMethod("builder-id");
    } else if (method === "idc") {
      // Use device code flow with IDC config
      setAuthMethod("idc");
      setIdcConfig(config ? { startUrl: config.startUrl, region: config.region } : null);
    } else if (method === "social") {
      // Use social login with manual callback
      setAuthMethod("social");
      setSocialProvider(config?.provider || null);
    } else if (method === "import" || method === "api-key" || method === "import-cli-proxy") {
      // Import / API-key handled in KiroAuthModal, just close
      onSuccess?.();
    }
  }, [onSuccess]);

  const handleBack = (): void => {
    setAuthMethod(null);
    setSocialProvider(null);
    setIdcConfig(null);
  };

  const handleSocialSuccess = (): void => {
    setAuthMethod(null);
    setSocialProvider(null);
    onSuccess?.();
    onClose?.(); // Close modal after success
  };

  const handleDeviceSuccess = (): void => {
    setAuthMethod(null);
    setIdcConfig(null);
    onSuccess?.();
    onClose?.(); // Close modal after success
  };

  // Show method selection first
  if (!authMethod) {
    return (
      <KiroAuthModal
        isOpen={isOpen}
        onMethodSelect={handleMethodSelect}
        onClose={onClose}
      />
    );
  }

  // Show device code flow (Builder ID or IDC)
  if (authMethod === "builder-id" || authMethod === "idc") {
    return (
      <OAuthModal
        isOpen={isOpen}
        provider="kiro"
        providerInfo={providerInfo}
        onSuccess={handleDeviceSuccess}
        onClose={handleBack}
        idcConfig={idcConfig}
      />
    );
  }

  // Show social login flow (Google/GitHub with manual callback)
  if (authMethod === "social" && socialProvider) {
    return (
      <KiroSocialOAuthModal
        isOpen={isOpen}
        provider={socialProvider as "google" | "github"}
        onSuccess={handleSocialSuccess}
        onClose={handleBack}
      />
    );
  }

  return null;
}
