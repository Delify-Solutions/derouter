"""
Type definitions for the DeRouter Policy Engine.

This module re-exports types from derouter.types.proxy.policy_engine for backward compatibility.
The canonical location for these types is derouter/types/proxy/policy_engine/.
"""

# Re-export all types from the new location
from derouter.types.proxy.policy_engine import (  # Policy types; Validation types; Resolver types
    Policy,
    PolicyConfig,
    PolicyGuardrails,
    PolicyMatchContext,
    PolicyScope,
    PolicyValidateRequest,
    PolicyValidationError,
    PolicyValidationErrorType,
    PolicyValidationResponse,
    ResolvedPolicy,
)

__all__ = [
    # Policy types
    "Policy",
    "PolicyConfig",
    "PolicyGuardrails",
    # Resolver types
    "PolicyMatchContext",
    "PolicyScope",
    # Validation types
    "PolicyValidateRequest",
    "PolicyValidationError",
    "PolicyValidationErrorType",
    "PolicyValidationResponse",
    "ResolvedPolicy",
]
