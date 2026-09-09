"""Generic prompt management integration for DeRouter."""

from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from derouter.integrations.custom_prompt_management import CustomPromptManagement
    from derouter.types.prompts.init_prompts import PromptDeRouterParams, PromptSpec

    from .generic_prompt_manager import GenericPromptManager

from derouter.types.prompts.init_prompts import SupportedPromptIntegrations

from .generic_prompt_manager import GenericPromptManager

# Global instances
global_generic_prompt_config: Final[dict | None] = None


def set_global_generic_prompt_config(config: dict) -> None:
    """
    Set the global generic prompt configuration.

    Args:
        config: Dictionary containing generic prompt configuration
                - api_base: Base URL for the API
                - api_key: Optional API key for authentication
                - timeout: Request timeout in seconds (default: 30)
    """
    import derouter

    derouter.global_generic_prompt_config = config


def prompt_initializer(derouter_params: "PromptDeRouterParams", prompt_spec: "PromptSpec") -> "CustomPromptManagement":
    """
    Initialize a prompt from a generic prompt management API.
    """
    prompt_id: Final = getattr(derouter_params, "prompt_id", None)

    api_base: Final = derouter_params.api_base
    api_key: Final = derouter_params.api_key
    if not api_base:
        raise ValueError("api_base is required in generic_prompt_config")

    provider_specific_query_params: Final = derouter_params.provider_specific_query_params

    try:
        generic_prompt_manager: Final = GenericPromptManager(
            api_base=api_base,
            api_key=api_key,
            prompt_id=prompt_id,
            additional_provider_specific_query_params=provider_specific_query_params,
            **derouter_params.model_dump(
                exclude_none=True,
                exclude={
                    "prompt_id",
                    "api_key",
                    "provider_specific_query_params",
                    "api_base",
                },
            ),
        )

        return generic_prompt_manager
    except Exception as e:
        raise e


prompt_initializer_registry: Final = {
    SupportedPromptIntegrations.GENERIC_PROMPT_MANAGEMENT.value: prompt_initializer,
}

# Export public API
__all__ = [
    "GenericPromptManager",
    "global_generic_prompt_config",
    "prompt_initializer_registry",
    "set_global_generic_prompt_config",
]
