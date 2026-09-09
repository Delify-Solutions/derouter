"""
SSO (Single Sign-On) related modules for DeRouter Proxy.

This package contains custom SSO implementations and utilities.
"""

from derouter.proxy.management_endpoints.sso.custom_microsoft_sso import (
    CustomMicrosoftSSO,
)

__all__ = ["CustomMicrosoftSSO"]
