from typing import TYPE_CHECKING, Any

from derouter.llms.azure.common_utils import BaseAzureLLM
from derouter.llms.openai.videos.transformation import OpenAIVideoConfig
from derouter.types.router import GenericDeRouterParams
from derouter.types.videos.main import VideoCreateOptionalRequestParams

if TYPE_CHECKING:
    from derouter.derouter_core_utils.derouter_logging import Logging as _DeRouterLoggingObj

    from ...base_llm.chat.transformation import BaseLLMException as _BaseLLMException
    from ...base_llm.videos.transformation import BaseVideoConfig as _BaseVideoConfig

    DeRouterLoggingObj = _DeRouterLoggingObj
    BaseVideoConfig = _BaseVideoConfig
    BaseLLMException = _BaseLLMException
else:
    DeRouterLoggingObj = Any
    BaseVideoConfig = Any
    BaseLLMException = Any


class AzureVideoConfig(OpenAIVideoConfig):
    """
    Configuration class for OpenAI video generation.
    """

    def __init__(self):
        super().__init__()

    def get_supported_openai_params(self, model: str) -> list:
        """
        Get the list of supported OpenAI parameters for video generation.
        """
        return [
            "model",
            "prompt",
            "input_reference",
            "seconds",
            "size",
            "user",
            "extra_headers",
        ]

    def map_openai_params(
        self,
        video_create_optional_params: VideoCreateOptionalRequestParams,
        model: str,
        drop_params: bool,
    ) -> dict:
        """No mapping applied since inputs are in OpenAI spec already"""
        return dict(video_create_optional_params)

    def validate_environment(
        self,
        headers: dict,
        model: str,
        api_key: str | None = None,
        derouter_params: GenericDeRouterParams | None = None,
    ) -> dict:
        """
        Validate Azure environment and set up authentication headers.
        Uses _base_validate_azure_environment to properly handle credentials from derouter_credential_name.
        """
        # If derouter_params is provided, use it; otherwise create a new one
        if derouter_params is None:
            derouter_params = GenericDeRouterParams()

        if api_key and not derouter_params.api_key:
            derouter_params.api_key = api_key

        # Use the base Azure validation method which properly handles:
        # 1. Credentials from derouter_credential_name via derouter_params
        # 2. Sets the correct "api-key" header (not "Authorization: Bearer")
        return BaseAzureLLM._base_validate_azure_environment(headers=headers, derouter_params=derouter_params)

    def get_complete_url(
        self,
        model: str,
        api_base: str | None,
        derouter_params: dict,
    ) -> str:
        """
        Constructs a complete URL for the API request.
        """
        return BaseAzureLLM._get_base_azure_url(
            api_base=api_base,
            derouter_params=derouter_params,
            route="/openai/v1/videos",
            default_api_version="",
        )
