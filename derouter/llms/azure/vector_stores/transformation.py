from derouter.llms.azure.common_utils import BaseAzureLLM
from derouter.llms.openai.vector_stores.transformation import OpenAIVectorStoreConfig
from derouter.types.router import GenericDeRouterParams


class AzureOpenAIVectorStoreConfig(OpenAIVectorStoreConfig):
    def get_complete_url(
        self,
        api_base: str | None,
        derouter_params: dict,
    ) -> str:
        return BaseAzureLLM._get_base_azure_url(
            api_base=api_base,
            derouter_params=derouter_params,
            route="/openai/vector_stores",
        )

    def validate_environment(self, headers: dict, derouter_params: GenericDeRouterParams | None) -> dict:
        return BaseAzureLLM._base_validate_azure_environment(headers=headers, derouter_params=derouter_params)
