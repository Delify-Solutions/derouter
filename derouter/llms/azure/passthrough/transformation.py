from typing import TYPE_CHECKING, Final, Optional

import httpx
from httpx import Response

from derouter.derouter_core_utils.derouter_logging import Logging
from derouter.llms.azure.common_utils import BaseAzureLLM
from derouter.llms.base_llm.passthrough.transformation import BasePassthroughConfig
from derouter.secret_managers.main import get_secret_str
from derouter.types.llms.openai import AllMessageValues
from derouter.types.router import GenericDeRouterParams

if TYPE_CHECKING:
    from httpx import URL

    from derouter.types.utils import CostResponseTypes


class AzurePassthroughConfig(BasePassthroughConfig):
    def is_streaming_request(self, endpoint: str, request_data: dict) -> bool:
        return "stream" in request_data

    def get_complete_url(
        self,
        api_base: str | None,
        api_key: str | None,
        model: str,
        endpoint: str,
        request_query_params: dict | None,
        derouter_params: dict,
    ) -> tuple["URL", str]:
        base_target_url: Final = self.get_api_base(api_base)

        if base_target_url is None:
            raise Exception("Azure api base not found")

        derouter_metadata: Final = derouter_params.get("derouter_metadata") or {}
        model_group: Final = derouter_metadata.get("model_group")
        if model_group and model_group in endpoint:
            endpoint = endpoint.replace(model_group, model)

        complete_url: Final = BaseAzureLLM._get_base_azure_url(
            api_base=base_target_url,
            derouter_params=derouter_params,
            route=endpoint,
            default_api_version=derouter_params.get("api_version"),
        )
        return (
            httpx.URL(complete_url),
            base_target_url,
        )

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
        return BaseAzureLLM._base_validate_azure_environment(
            headers=headers,
            derouter_params=GenericDeRouterParams(**{**derouter_params, "api_key": api_key}),
        )

    @staticmethod
    def get_api_base(
        api_base: str | None = None,
    ) -> str | None:
        return api_base or get_secret_str("AZURE_API_BASE")

    @staticmethod
    def get_api_key(
        api_key: str | None = None,
    ) -> str | None:
        return api_key or get_secret_str("AZURE_API_KEY")

    @staticmethod
    def get_base_model(model: str) -> str | None:
        return model

    def get_models(self, api_key: str | None = None, api_base: str | None = None) -> list[str]:
        return super().get_models(api_key, api_base)

    def logging_non_streaming_response(
        self,
        model: str,
        custom_llm_provider: str,
        httpx_response: Response,
        request_data: dict,
        logging_obj: Logging,
        endpoint: str,
    ) -> Optional["CostResponseTypes"]:
        from derouter import encoding
        from derouter.llms.openai.chat.gpt_transformation import OpenAIGPTConfig
        from derouter.types.utils import ModelResponse

        if "chat/completions" not in endpoint:
            return None

        openai_chat_config: Final = OpenAIGPTConfig()

        derouter_model_response: Final[ModelResponse] = openai_chat_config.transform_response(
            model=model,
            messages=[{"role": "user", "content": "no-message-pass-through-endpoint"}],
            raw_response=httpx_response,
            model_response=ModelResponse(),
            logging_obj=logging_obj,
            optional_params={},
            derouter_params={},
            api_key="",
            request_data=request_data,
            encoding=encoding,
        )

        return derouter_model_response
