from derouter._logging import verbose_proxy_logger
from derouter.derouter_core_utils.dd_tracing import set_active_span_tag
from derouter.proxy._types import UserAPIKeyAuth


class DDSpanTagger:
    """Best-effort helpers for tagging the active Datadog APM span with DeRouter request metadata."""

    @staticmethod
    def tag_call_id(derouter_call_id: str | None) -> None:
        """
        Attach DeRouter call id to the active Datadog APM span.

        This enables searching APM traces by DeRouter call id returned in
        `x-derouter-call-id`.
        """
        if not derouter_call_id:
            return
        try:
            set_active_span_tag("derouter.call_id", str(derouter_call_id))
        except Exception:
            verbose_proxy_logger.debug(
                "Failed to tag active ddtrace span with derouter.call_id",
                exc_info=True,
            )

    @staticmethod
    def tag_request(
        user_api_key_dict: UserAPIKeyAuth,
        requested_model: str | None,
    ) -> None:
        """
        Attach key and model tags to the active Datadog APM span.

        Tags set (all best-effort, skipped when value is absent):
        - ``derouter.key_alias``      — human-readable alias for the API key
        - ``derouter.key_hash``       — hashed API key (safe to log; never the raw secret)
        - ``derouter.requested_model``— model name as sent by the client

        Use cases:
        - Trace all requests from a specific user/key: filter by ``derouter.key_alias`` or
          ``derouter.key_hash``.
        - Trace all requests for a specific model: filter by ``derouter.requested_model``.

        Note: key_alias / key_hash are not available for unauthenticated (e.g. 401) requests.
        """
        try:
            if user_api_key_dict.key_alias:
                set_active_span_tag("derouter.key_alias", str(user_api_key_dict.key_alias))
            if user_api_key_dict.token:
                set_active_span_tag("derouter.key_hash", str(user_api_key_dict.token))
            if requested_model:
                set_active_span_tag("derouter.requested_model", str(requested_model))
        except Exception:
            verbose_proxy_logger.debug(
                "Failed to tag active ddtrace span with key/model tags",
                exc_info=True,
            )
