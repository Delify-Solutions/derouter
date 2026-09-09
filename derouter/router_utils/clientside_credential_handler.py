"""
Utils for handling clientside credentials

Supported clientside credentials:
- api_key
- api_base
- base_url

If given, generate a unique model_id for the deployment.

Ensures cooldowns are applied correctly.
"""

from typing import Final

clientside_credential_keys: Final = ["api_key", "api_base", "base_url"]


def _admin_config_fields_to_clear_on_base_override() -> list[str]:
    """
    Provider-specific credential / endpoint-targeting fields that must NOT
    flow through to a client-redirected upstream.

    Built dynamically from ``CredentialDeRouterParams.model_fields`` so any
    new provider field added there (Bedrock endpoint, Watsonx region, etc.)
    is gated automatically — plus a fixed list of kwargs-only fields that
    aren't declared on the typed model.
    """
    from derouter.types.router import CredentialDeRouterParams

    typed_fields: Final = [f for f in CredentialDeRouterParams.model_fields if f not in clientside_credential_keys]
    kwargs_only_fields: Final = [
        # Caller-supplied via **kwargs, not declared on CredentialDeRouterParams.
        "organization",
        "extra_body",
        "extra_headers",
        "default_headers",
        "api_type",
        "azure_ad_token",
        "azure_ad_token_provider",
        "aws_session_token",
        "aws_sts_endpoint",
        "aws_web_identity_token",
        "aws_role_name",
        # OCI provider — consumed by derouter/llms/oci/* via optional_params
        # and not declared on CredentialDeRouterParams. Without these here,
        # an admin's OCI signing key / tenancy / fingerprint would flow
        # through to an attacker-redirected upstream.
        "oci_signer",
        "oci_user",
        "oci_fingerprint",
        "oci_tenancy",
        "oci_key",
        "oci_key_file",
        # NVIDIA Riva fields — consumed by
        # ``derouter/llms/nvidia_riva/audio_transcription/handler.py`` via
        # optional_params and not declared on CredentialDeRouterParams.
        # Admin-pinned values must not flow through on a caller-redirected
        # ``api_base`` for the same reason as the OCI entries above.
        "nvcf_function_id",
        "use_ssl",
    ]
    return typed_fields + kwargs_only_fields


_ADMIN_CONFIG_FIELDS_TO_CLEAR_ON_BASE_OVERRIDE: Final = _admin_config_fields_to_clear_on_base_override()


def is_clientside_credential(request_kwargs: dict) -> bool:
    """
    Check if the credential is a clientside credential.
    """
    return any(key in request_kwargs for key in clientside_credential_keys)


def get_dynamic_derouter_params(derouter_params: dict, request_kwargs: dict) -> dict:
    """
    Generate a unique model_id for the deployment.

    Returns
    - derouter_params: dict

    for generating a unique model_id.
    """
    # update derouter_params with clientside credentials
    for key in clientside_credential_keys:
        if key in request_kwargs:
            derouter_params[key] = request_kwargs[key]

    # If the caller redirected api_base/base_url to a client-controlled value,
    # don't forward the admin's organization / extra_body / region / token /
    # vertex / aws fields — those were meant for the original upstream.
    # Always drop the admin's value first, then write the caller's value back
    # if they resupplied the field. The naive
    # ``if field not in request_kwargs: pop`` shape lets a caller *echo* a
    # field name (with any value, including an empty string) to keep the
    # admin's value in ``derouter_params`` and have it forwarded to the
    # redirected upstream.
    if "api_base" in request_kwargs or "base_url" in request_kwargs:
        for field in _ADMIN_CONFIG_FIELDS_TO_CLEAR_ON_BASE_OVERRIDE:
            derouter_params.pop(field, None)
            if field in request_kwargs:
                derouter_params[field] = request_kwargs[field]

    return derouter_params
