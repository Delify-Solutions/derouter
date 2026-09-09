"""
Proxy Authentication module for DeRouter SDK.

This module provides OAuth2/JWT token management for authenticating
with DeRouter Proxy or any OAuth2-protected endpoint.

Usage:
    from derouter.proxy_auth import AzureADCredential, ProxyAuthHandler

    derouter.proxy_auth = ProxyAuthHandler(
        credential=AzureADCredential(),
        scope="api://my-proxy/.default"
    )
"""

from .credentials import (
    AccessToken,
    AzureADCredential,
    GenericOAuth2Credential,
    ProxyAuthHandler,
    TokenCredential,
)

__all__ = [
    "AccessToken",
    "AzureADCredential",
    "GenericOAuth2Credential",
    "ProxyAuthHandler",
    "TokenCredential",
]
