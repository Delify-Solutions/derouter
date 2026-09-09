from typing import Final

import derouter
from derouter import verbose_logger

from ...derouter_core_utils.get_llm_provider_logic import get_llm_provider
from ...types.router import DeRouter_Params


def get_api_base(model: str, optional_params: dict | DeRouter_Params) -> str | None:
    """
    Returns the api base used for calling the model.

    Parameters:
    - model: str - the model passed to derouter.completion()
    - optional_params - the 'derouter_params' in router.completion *OR* additional params passed to derouter.completion - eg. api_base, api_key, etc. See `DeRouter_Params` - https://github.com/Delify-Solutions/derouter/blob/f09e6ba98d65e035a79f73bc069145002ceafd36/derouter/router.py#L67

    Returns:
    - string (api_base) or None

    Example:
    ```
    from derouter import get_api_base

    get_api_base(model="gemini/gemini-pro")
    ```
    """

    try:
        if isinstance(optional_params, DeRouter_Params):
            _optional_params = optional_params
        elif "model" in optional_params:
            _optional_params = DeRouter_Params(**optional_params)
        else:  # prevent needing to copy and pop the dict
            _optional_params = DeRouter_Params(model=model, **optional_params)  # convert to pydantic object
    except Exception:
        return None
    # get llm provider

    if _optional_params.api_base is not None:
        return _optional_params.api_base

    if derouter.model_alias_map and model in derouter.model_alias_map:
        model = derouter.model_alias_map[model]
    try:
        (
            model,
            custom_llm_provider,
            dynamic_api_key,
            dynamic_api_base,
        ) = get_llm_provider(
            model=model,
            custom_llm_provider=_optional_params.custom_llm_provider,
            api_base=_optional_params.api_base,
            api_key=_optional_params.api_key,
        )
    except Exception as e:
        verbose_logger.debug("Error occurred in getting api base - %s", e)
        custom_llm_provider = None
        dynamic_api_base = None

    if dynamic_api_base is not None:
        return dynamic_api_base

    stream: Final[bool] = getattr(optional_params, "stream", False)

    if _optional_params.vertex_location is not None and _optional_params.vertex_project is not None:
        from derouter.llms.vertex_ai.vertex_llm_base import VertexBase
        from derouter.types.llms.vertex_ai import VertexPartnerProvider

        if "claude" in model:
            _api_base = VertexBase.create_vertex_url(
                vertex_location=_optional_params.vertex_location,
                vertex_project=_optional_params.vertex_project,
                model=model,
                stream=stream,
                partner=VertexPartnerProvider.claude,
            )
        else:
            if stream:
                _api_base = f"{_optional_params.vertex_location}-aiplatform.googleapis.com/v1/projects/{_optional_params.vertex_project}/locations/{_optional_params.vertex_location}/publishers/google/models/{model}:streamGenerateContent"
            else:
                _api_base = f"{_optional_params.vertex_location}-aiplatform.googleapis.com/v1/projects/{_optional_params.vertex_project}/locations/{_optional_params.vertex_location}/publishers/google/models/{model}:generateContent"
        return _api_base

    if custom_llm_provider is None:
        return None

    if custom_llm_provider == "gemini":
        if stream:
            _api_base = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent"
        else:
            _api_base = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        return _api_base
    elif custom_llm_provider == "openai":
        _api_base = "https://api.openai.com"
        return _api_base
    return None
