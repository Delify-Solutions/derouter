# derouter/proxy/guardrails/guardrail_initializers.py
from typing import Any, Final

import derouter
from derouter.integrations.custom_guardrail import CustomGuardrail
from derouter.proxy._types import CommonProxyErrors
from derouter.types.guardrails import *


def initialize_bedrock(derouter_params: LitellmParams, guardrail: Guardrail):
    from derouter.proxy.guardrails.guardrail_hooks.bedrock_guardrails import (
        BedrockGuardrail,
    )

    streaming_params: Final = BedrockGuardrailStreamingParams.from_extras(derouter_params.model_extra)
    _bedrock_callback: Final = BedrockGuardrail(
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        guardrailIdentifier=derouter_params.guardrailIdentifier,
        guardrailVersion=derouter_params.guardrailVersion,
        checks=derouter_params.checks,
        content_filter_threshold=derouter_params.content_filter_threshold,
        prompt_attack_threshold=derouter_params.prompt_attack_threshold,
        pii_confidence_threshold=derouter_params.pii_confidence_threshold,
        chunk_budget_chars=derouter_params.chunk_budget_chars,
        default_on=derouter_params.default_on,
        disable_exception_on_block=derouter_params.disable_exception_on_block,
        mask_request_content=derouter_params.mask_request_content,
        mask_response_content=derouter_params.mask_response_content,
        aws_region_name=derouter_params.aws_region_name,
        aws_access_key_id=derouter_params.aws_access_key_id,
        aws_secret_access_key=derouter_params.aws_secret_access_key,
        aws_session_token=derouter_params.aws_session_token,
        aws_session_name=derouter_params.aws_session_name,
        aws_profile_name=derouter_params.aws_profile_name,
        aws_role_name=derouter_params.aws_role_name,
        aws_web_identity_token=derouter_params.aws_web_identity_token,
        aws_sts_endpoint=derouter_params.aws_sts_endpoint,
        aws_external_id=derouter_params.aws_external_id,
        aws_bedrock_runtime_endpoint=derouter_params.aws_bedrock_runtime_endpoint,
        experimental_use_latest_role_message_only=derouter_params.experimental_use_latest_role_message_only,
        only_scan_new_messages=derouter_params.only_scan_new_messages or False,
        streaming_buffer_until_moderated=streaming_params.streaming_buffer_until_moderated,
        streaming_sampling_rate=streaming_params.streaming_sampling_rate,
        streaming_end_of_stream_only=streaming_params.streaming_end_of_stream_only,
    )
    derouter.logging_callback_manager.add_derouter_callback(_bedrock_callback)
    return _bedrock_callback


def initialize_lakera(derouter_params: LitellmParams, guardrail: Guardrail):
    from derouter.proxy.guardrails.guardrail_hooks.lakera_ai import lakeraAI_Moderation

    _lakera_callback: Final = lakeraAI_Moderation(
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        category_thresholds=derouter_params.category_thresholds,
        default_on=derouter_params.default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(_lakera_callback)
    return _lakera_callback


def initialize_lakera_v2(derouter_params: LitellmParams, guardrail: Guardrail):
    from derouter.proxy.guardrails.guardrail_hooks.lakera_ai_v2 import LakeraAIGuardrail

    _lakera_v2_callback: Final = LakeraAIGuardrail(
        api_base=derouter_params.api_base,
        api_key=derouter_params.api_key,
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
        project_id=derouter_params.project_id,
        payload=derouter_params.payload,
        breakdown=derouter_params.breakdown,
        metadata=derouter_params.metadata,
        dev_info=derouter_params.dev_info,
        on_flagged=derouter_params.on_flagged,
        skip_system_message_in_guardrail=derouter_params.skip_system_message_in_guardrail,
        skip_tool_message_in_guardrail=derouter_params.skip_tool_message_in_guardrail,
        advisory_system_message=derouter_params.advisory_system_message,
    )
    derouter.logging_callback_manager.add_derouter_callback(_lakera_v2_callback)
    return _lakera_v2_callback


def initialize_presidio(derouter_params: LitellmParams, guardrail: Guardrail) -> tuple[CustomGuardrail, ...]:
    from derouter.proxy.guardrails.guardrail_hooks.presidio import (
        _OPTIONAL_PresidioPIIMasking,
    )

    filter_scope: Final = getattr(derouter_params, "presidio_filter_scope", None) or "both"
    run_input: Final = filter_scope in ("input", "both")
    run_output: Final = filter_scope in ("output", "both")

    def _make_presidio_callback(**overrides) -> CustomGuardrail:
        params: Final = dict(
            guardrail_name=guardrail.get("guardrail_name", ""),
            event_hook=derouter_params.mode,
            output_parse_pii=derouter_params.output_parse_pii,
            presidio_ad_hoc_recognizers=derouter_params.presidio_ad_hoc_recognizers,
            mock_redacted_text=derouter_params.mock_redacted_text,
            default_on=derouter_params.default_on,
            pii_entities_config=derouter_params.pii_entities_config,
            presidio_score_thresholds=derouter_params.presidio_score_thresholds,
            presidio_analyzer_api_base=derouter_params.presidio_analyzer_api_base,
            presidio_anonymizer_api_base=derouter_params.presidio_anonymizer_api_base,
            presidio_language=derouter_params.presidio_language,
            presidio_entities_deny_list=derouter_params.presidio_entities_deny_list,
            apply_to_output=False,
        )
        params.update(overrides)
        # Passed outside the heterogeneous params dict so the argument keeps
        # its precise int | None type.
        callback: Final = _OPTIONAL_PresidioPIIMasking(
            presidio_analyze_chunk_size_bytes=derouter_params.presidio_analyze_chunk_size_bytes,
            **params,
        )
        derouter.logging_callback_manager.add_derouter_callback(callback)
        return callback

    input_callback: Final = _make_presidio_callback() if run_input else None
    unmask_output_callback: Final = (
        _make_presidio_callback(
            output_parse_pii=True,
            event_hook=GuardrailEventHooks.post_call.value,
        )
        if run_input and derouter_params.output_parse_pii
        else None
    )
    mask_output_callback: Final = (
        _make_presidio_callback(
            apply_to_output=True,
            event_hook=GuardrailEventHooks.post_call.value,
            output_parse_pii=False,
        )
        if run_output
        else None
    )
    return tuple(
        callback for callback in (input_callback, unmask_output_callback, mask_output_callback) if callback is not None
    )


def initialize_hide_secrets(derouter_params: LitellmParams, guardrail: Guardrail):
    try:
        from derouter_enterprise.enterprise_callbacks.secret_detection import (
            _ENTERPRISE_SecretDetection,
        )
    except ImportError:
        raise Exception("Trying to use Secret Detection" + CommonProxyErrors.missing_enterprise_package.value)

    _secret_detection_object: Final = _ENTERPRISE_SecretDetection(
        detect_secrets_config=derouter_params.detect_secrets_config,
        event_hook=derouter_params.mode,
        guardrail_name=guardrail.get("guardrail_name", ""),
        default_on=derouter_params.default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(_secret_detection_object)
    return _secret_detection_object


def initialize_tool_permission(derouter_params: LitellmParams, guardrail: Guardrail):
    from derouter.proxy.guardrails.guardrail_hooks.tool_permission import (
        ToolPermissionGuardrail,
    )

    rules: list[dict[str, Any]] | None = None
    if derouter_params.rules:
        rules = []
        for rule in derouter_params.rules:
            if hasattr(rule, "model_dump"):
                rules.append(rule.model_dump())
            else:
                rules.append(dict(rule))

    _tool_permission_callback: Final = ToolPermissionGuardrail(
        guardrail_name=guardrail.get("guardrail_name", ""),
        event_hook=derouter_params.mode,
        rules=rules,
        default_action=getattr(derouter_params, "default_action", "deny"),
        on_disallowed_action=getattr(derouter_params, "on_disallowed_action", "block"),
        default_on=derouter_params.default_on,
        violation_message_template=derouter_params.violation_message_template,
    )
    derouter.logging_callback_manager.add_derouter_callback(_tool_permission_callback)
    return _tool_permission_callback


def initialize_lasso(
    derouter_params: LitellmParams,
    guardrail: Guardrail,
):
    from derouter.proxy.guardrails.guardrail_hooks.lasso import LassoGuardrail

    _lasso_callback: Final = LassoGuardrail(
        guardrail_name=guardrail.get("guardrail_name", ""),
        lasso_api_key=derouter_params.api_key,
        api_base=derouter_params.api_base,
        user_id=derouter_params.lasso_user_id,
        conversation_id=derouter_params.lasso_conversation_id,
        mask=derouter_params.mask,
        event_hook=derouter_params.mode,
        default_on=derouter_params.default_on,
    )
    derouter.logging_callback_manager.add_derouter_callback(_lasso_callback)

    return _lasso_callback


def initialize_panw_prisma_airs(derouter_params, guardrail):
    from derouter.proxy.guardrails.guardrail_hooks.panw_prisma_airs import (
        PanwPrismaAirsHandler,
    )

    if not derouter_params.api_key:
        raise ValueError("PANW Prisma AIRS: api_key is required")
    if not derouter_params.profile_name:
        raise ValueError("PANW Prisma AIRS: profile_name is required")

    _panw_callback: Final = PanwPrismaAirsHandler(
        guardrail_name=guardrail.get("guardrail_name", "panw_prisma_airs"),  # Use .get() with default
        api_key=derouter_params.api_key,
        api_base=derouter_params.api_base or "https://service.api.aisecurity.paloaltonetworks.com/v1/scan/sync/request",
        profile_name=derouter_params.profile_name,
        default_on=derouter_params.default_on,
        mask_on_block=getattr(derouter_params, "mask_on_block", False),
        mask_request_content=getattr(derouter_params, "mask_request_content", False),
        mask_response_content=getattr(derouter_params, "mask_response_content", False),
        app_name=getattr(derouter_params, "app_name", None),
        fallback_on_error=getattr(derouter_params, "fallback_on_error", "block"),
        # `timeout` is now declared on BaseLitellmParams (Optional[float] = None),
        # so the attribute always exists. The Pydantic validator on LitellmParams
        # coerces strings to float, but None still means "use handler default" —
        # guard against float(None) here.
        timeout=(
            float(getattr(derouter_params, "timeout", None))
            if getattr(derouter_params, "timeout", None) is not None
            else 10.0
        ),
        violation_message_template=derouter_params.violation_message_template,
    )
    derouter.logging_callback_manager.add_derouter_callback(_panw_callback)

    return _panw_callback
