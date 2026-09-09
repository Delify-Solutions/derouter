"""
OpenAI-like Responses API transformation.

Base class for JSON-declared providers that support the /v1/responses endpoint.
Inherits everything from OpenAIResponsesAPIConfig; subclasses only override
provider-specific resolution (slug, API key env var, base URL).
"""

from typing import Final

from derouter.llms.openai.responses.transformation import OpenAIResponsesAPIConfig
from derouter.secret_managers.main import get_secret_str
from derouter.types.router import GenericDeRouterParams
from derouter.types.utils import LlmProviders


class OpenAILikeResponsesConfig(OpenAIResponsesAPIConfig):
    """
    Responses API config for OpenAI-compatible providers declared via JSON.

    Concrete per-provider classes are generated dynamically in dynamic_config.py.
    This base provides the three overridable hooks that the dynamic generator
    fills in: custom_llm_provider, validate_environment, get_complete_url.
    """

    @property
    def custom_llm_provider(self) -> str | LlmProviders:
        return "openai_like"

    def validate_environment(
        self,
        headers: dict,
        model: str,
        derouter_params: GenericDeRouterParams | None,
    ) -> dict:
        derouter_params = derouter_params or GenericDeRouterParams()
        api_key: Final = derouter_params.api_key or get_secret_str("OPENAI_LIKE_API_KEY")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers

    def get_complete_url(
        self,
        api_base: str | None,
        derouter_params: dict,
    ) -> str:
        api_base = api_base or get_secret_str("OPENAI_LIKE_API_BASE")
        if not api_base:
            raise ValueError("api_base is required for openai_like provider")
        api_base = api_base.rstrip("/")
        return f"{api_base}/responses"
