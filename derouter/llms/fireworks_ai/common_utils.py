from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

from httpx import Headers

from derouter.constants import SESSION_ID_GENERATED_METADATA_KEY
from derouter.secret_managers.main import get_secret_str
from derouter.types.llms.openai import AllMessageValues

from ..base_llm.chat.transformation import BaseLLMException


class FireworksAIException(BaseLLMException):
    pass


def get_fireworks_session_id(derouter_params: Mapping[str, object]) -> str | None:
    """
    Session id to send as `x-session-affinity`, or None when the caller gave none.

    Deliberately does not fall back to `derouter_trace_id`, and ignores session ids the
    proxy generated for a request that had none: both are per request, so using them
    pins every request to a different Fireworks node and prompt caching never hits.
    """
    params: Final = derouter_params
    metadata: Final = params.get("metadata")
    if isinstance(metadata, Mapping) and metadata.get(SESSION_ID_GENERATED_METADATA_KEY):
        return None
    for key in ("derouter_session_id", "session_id"):
        value = params.get(key)
        if value:
            return str(value)
    if isinstance(metadata, Mapping):
        value = metadata.get("session_id")
        if value:
            return str(value)
    return None


def with_fireworks_session_affinity(
    headers: Mapping[str, str], derouter_params: Mapping[str, object]
) -> Mapping[str, str]:
    if any(key.lower() == "x-session-affinity" for key in headers):
        return headers
    session_id: Final = get_fireworks_session_id(derouter_params)
    if not session_id:
        return headers
    return MappingProxyType({**headers, "x-session-affinity": session_id})


def resolve_fireworks_api_key(api_key: str | None) -> str | None:
    return api_key or (
        get_secret_str("FIREWORKS_API_KEY")
        or get_secret_str("FIREWORKS_AI_API_KEY")
        or get_secret_str("FIREWORKSAI_API_KEY")
        or get_secret_str("FIREWORKS_AI_TOKEN")
    )


AZURE_FOUNDRY_FIREWORKS_MODEL_ID_PREFIX: Final = "FW-"


def resolve_fireworks_resource_name(model: str) -> str:
    stripped: Final = model.removeprefix("fireworks_ai/")
    if stripped.startswith(("accounts/", AZURE_FOUNDRY_FIREWORKS_MODEL_ID_PREFIX)) or "#" in stripped:
        return stripped
    if stripped.startswith(("routers/", "models/")):
        return f"accounts/fireworks/{stripped}"
    if stripped.endswith("-fast"):
        return f"accounts/fireworks/routers/{stripped}"
    return f"accounts/fireworks/models/{stripped}"


class FireworksAIMixin:
    """
    Common Base Config functions across Fireworks AI Endpoints
    """

    def get_error_class(self, error_message: str, status_code: int, headers: dict | Headers) -> BaseLLMException:
        return FireworksAIException(
            status_code=status_code,
            message=error_message,
            headers=headers,
        )

    def _get_api_key(self, api_key: str | None) -> str | None:
        return resolve_fireworks_api_key(api_key)

    def validate_environment(
        self,
        headers: dict,
        model: str,
        messages: list[AllMessageValues],
        optional_params: dict,
        derouter_params: dict,
        api_key: str | None = None,
        api_base: str | None = None,
    ) -> dict:
        api_key = self._get_api_key(api_key)
        if api_key is None:
            raise ValueError("FIREWORKS_API_KEY is not set")

        auth_headers: Final = {"Authorization": f"Bearer {api_key}", **headers}
        content_type_header: Final = (
            {} if any(key.lower() == "content-type" for key in auth_headers) else {"Content-Type": "application/json"}
        )
        return self._add_session_affinity_header({**auth_headers, **content_type_header}, derouter_params)

    def _add_session_affinity_header(self, headers: dict, derouter_params: dict) -> dict:
        pinned: Final = with_fireworks_session_affinity(headers, derouter_params)
        return dict(pinned)  # mutable-ok: the HTTP handler updates the returned headers in place
