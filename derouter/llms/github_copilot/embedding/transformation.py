"""
GitHub Copilot Embedding API Configuration.

This module provides the configuration for GitHub Copilot's Embedding API.

Implementation based on analysis of the copilot-api project by caozhiyuan:
https://github.com/caozhiyuan/copilot-api
"""

import os
from typing import TYPE_CHECKING, Any, Final

import httpx

from derouter._logging import verbose_logger
from derouter.exceptions import AuthenticationError
from derouter.llms.base_llm.embedding.transformation import BaseEmbeddingConfig
from derouter.types.llms.openai import AllEmbeddingInputValues
from derouter.types.utils import EmbeddingResponse
from derouter.utils import convert_to_model_response_object

from ..authenticator import Authenticator
from ..common_utils import (
    DEFAULT_GITHUB_COPILOT_API_BASE,
    GetAPIKeyError,
    get_copilot_default_headers,
)

if TYPE_CHECKING:
    from derouter.derouter_core_utils.derouter_logging import Logging as _DeRouterLoggingObj

    DeRouterLoggingObj = _DeRouterLoggingObj
else:
    DeRouterLoggingObj = Any


class GithubCopilotEmbeddingConfig(BaseEmbeddingConfig):
    """
    Configuration for GitHub Copilot's Embedding API.

    Reference: https://api.githubcopilot.com/embeddings
    """

    def __init__(self) -> None:
        super().__init__()
        self.authenticator = Authenticator()

    def validate_environment(
        self,
        headers: dict,
        model: str,
        messages: list,
        optional_params: dict,
        derouter_params: dict,
        api_key: str | None = None,
        api_base: str | None = None,
    ) -> dict:
        """
        Validate environment and set up headers for GitHub Copilot API.
        """
        try:
            # Get GitHub Copilot API key via OAuth
            api_key = self.authenticator.get_api_key()

            if not api_key:
                raise AuthenticationError(
                    model=model,
                    llm_provider="github_copilot",
                    message="GitHub Copilot API key is required. Please authenticate via OAuth Device Flow.",
                )

            # Get default headers
            default_headers: Final = get_copilot_default_headers(api_key)

            # Merge with existing headers (user's extra_headers take priority)
            merged_headers: Final = {**default_headers, **headers}

            verbose_logger.debug("GitHub Copilot Embedding API: Successfully configured headers for model %s", model)

            return merged_headers

        except GetAPIKeyError as e:
            raise AuthenticationError(
                model=model,
                llm_provider="github_copilot",
                message=str(e),
            )

    def get_complete_url(
        self,
        api_base: str | None,
        api_key: str | None,
        model: str,
        optional_params: dict,
        derouter_params: dict,
        stream: bool | None = None,
    ) -> str:
        """
        Get the complete URL for GitHub Copilot Embedding API endpoint.
        """
        # Use provided api_base or fall back to authenticator's base or default
        effective_api_base = (
            api_base
            or self.authenticator.get_api_base()
            or os.getenv("GITHUB_COPILOT_API_BASE")
            or DEFAULT_GITHUB_COPILOT_API_BASE
        )

        # Remove trailing slashes
        effective_api_base = effective_api_base.rstrip("/")

        # Return the embeddings endpoint
        return f"{effective_api_base}/embeddings"

    def transform_embedding_request(
        self,
        model: str,
        input: AllEmbeddingInputValues,
        optional_params: dict,
        headers: dict,
    ) -> dict:
        """
        Transform embedding request to GitHub Copilot format.
        """

        # Ensure input is a list
        if isinstance(input, str):
            input = [input]

        # Strip 'github_copilot/' prefix if present
        if model.startswith("github_copilot/"):
            model = model.replace("github_copilot/", "", 1)

        return {
            "model": model,
            "input": input,
            **optional_params,
        }

    def transform_embedding_response(
        self,
        model: str,
        raw_response: httpx.Response,
        model_response: EmbeddingResponse,
        logging_obj: DeRouterLoggingObj,
        api_key: str | None,
        request_data: dict,
        optional_params: dict,
        derouter_params: dict,
    ) -> EmbeddingResponse:
        """
        Transform embedding response from GitHub Copilot format.
        """
        logging_obj.post_call(original_response=raw_response.text)

        # GitHub Copilot returns standard OpenAI-compatible embedding response
        response_json: Final = raw_response.json()

        return convert_to_model_response_object(
            response_object=response_json,
            model_response_object=model_response,
            response_type="embedding",
        )

    def get_supported_openai_params(self, model: str) -> list:
        return [
            "timeout",
            "dimensions",
            "encoding_format",
            "user",
        ]

    def map_openai_params(
        self,
        non_default_params: dict,
        optional_params: dict,
        model: str,
        drop_params: bool,
    ) -> dict:
        for param, value in non_default_params.items():
            if param in self.get_supported_openai_params(model):
                optional_params[param] = value
        return optional_params

    def get_error_class(self, error_message: str, status_code: int, headers: Any) -> Any:
        from derouter.llms.openai.openai import OpenAIConfig

        return OpenAIConfig().get_error_class(error_message=error_message, status_code=status_code, headers=headers)
