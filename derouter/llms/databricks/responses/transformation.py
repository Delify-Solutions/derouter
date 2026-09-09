"""
Databricks Responses API configuration.

Inherits from OpenAIResponsesAPIConfig since Databricks' Responses API
is compatible with OpenAI's for GPT models.

Reference: https://docs.databricks.com/aws/en/machine-learning/foundation-model-apis/api-reference
"""

import os
from typing import TYPE_CHECKING, Any, Final

from derouter.llms.databricks.common_utils import DatabricksBase
from derouter.llms.openai.responses.transformation import OpenAIResponsesAPIConfig
from derouter.types.llms.openai import ResponseInputParam
from derouter.types.router import GenericDeRouterParams
from derouter.types.utils import LlmProviders

if TYPE_CHECKING:
    from derouter.derouter_core_utils.derouter_logging import Logging as _DeRouterLoggingObj

    DeRouterLoggingObj = _DeRouterLoggingObj
else:
    DeRouterLoggingObj = Any


class DatabricksResponsesAPIConfig(DatabricksBase, OpenAIResponsesAPIConfig):
    """
    Configuration for Databricks Responses API.

    Inherits from OpenAIResponsesAPIConfig since Databricks' Responses API
    is largely compatible with OpenAI's for GPT models.

    Note: The Responses API on Databricks is only compatible with OpenAI GPT models.
    """

    @property
    def custom_llm_provider(self) -> LlmProviders:
        return LlmProviders.DATABRICKS

    def validate_environment(
        self,
        headers: dict,
        model: str,
        derouter_params: GenericDeRouterParams | None,
    ) -> dict:
        derouter_params = derouter_params or GenericDeRouterParams()
        api_key: Final = derouter_params.api_key or os.getenv("DATABRICKS_API_KEY")
        api_base: Final = derouter_params.api_base or os.getenv("DATABRICKS_API_BASE")

        # Reuse Databricks auth logic (OAuth M2M, PAT, SDK fallback).
        # custom_endpoint=False allows SDK auth fallback; the appended
        # /chat/completions suffix is harmless since we discard api_base
        # here and build the URL separately in get_complete_url().
        _, headers = self.databricks_validate_environment(
            api_key=api_key,
            api_base=api_base,
            endpoint_type="chat_completions",
            custom_endpoint=False,
            headers=headers,
        )

        headers["Content-Type"] = "application/json"
        return headers

    def get_complete_url(
        self,
        api_base: str | None,
        derouter_params: dict,
    ) -> str:
        api_base = api_base or os.getenv("DATABRICKS_API_BASE")
        api_base = self._get_api_base(api_base)
        api_base = api_base.rstrip("/")
        return f"{api_base}/responses"

    def transform_responses_api_request(
        self,
        model: str,
        input: str | ResponseInputParam,
        response_api_optional_request_params: dict,
        derouter_params: GenericDeRouterParams,
        headers: dict,
    ) -> dict:
        """
        Transform request for Databricks Responses API.

        Strips the 'databricks/' prefix from model name if present,
        then delegates to OpenAI's transformation.
        """
        # Strip provider prefix if present (e.g., "databricks/databricks-gpt-5-nano" -> "databricks-gpt-5-nano")
        model = model.removeprefix("databricks/")

        return super().transform_responses_api_request(
            model=model,
            input=input,
            response_api_optional_request_params=response_api_optional_request_params,
            derouter_params=derouter_params,
            headers=headers,
        )

    def supports_native_websocket(self) -> bool:
        """Databricks does not support native WebSocket for Responses API"""
        return False
