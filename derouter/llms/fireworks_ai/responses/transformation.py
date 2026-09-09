from collections.abc import Mapping, Sequence
from types import MappingProxyType
from typing import TYPE_CHECKING, Final
from urllib.parse import unquote

import httpx
from openai.types.responses import EasyInputMessageParam, ResponseInputContentParam, ResponseInputItemParam

from derouter.llms.fireworks_ai.common_utils import (
    resolve_fireworks_api_key,
    resolve_fireworks_resource_name,
    with_fireworks_session_affinity,
)
from derouter.llms.openai.responses.transformation import OpenAIResponsesAPIConfig
from derouter.secret_managers.main import get_secret_str
from derouter.types.llms.openai import ResponseInputParam
from derouter.types.responses.main import DeleteResponseResult
from derouter.types.router import GenericDeRouterParams
from derouter.types.utils import LlmProviders

if TYPE_CHECKING:
    from derouter.derouter_core_utils.derouter_logging import Logging as DeRouterLoggingObj

FIREWORKS_AI_DEFAULT_API_BASE: Final = "https://api.fireworks.ai/inference/v1"


def _session_params(derouter_params: GenericDeRouterParams) -> Mapping[str, object]:
    extras: Final[Mapping[str, object]] = derouter_params.model_extra or MappingProxyType({})
    return MappingProxyType(
        {"derouter_session_id": extras.get("derouter_session_id"), "metadata": extras.get("derouter_metadata")}
    )


_INSTRUCTION_ROLES: Final = frozenset({"system", "developer"})


def _role(item: ResponseInputItemParam) -> str | None:
    match item:
        case {"role": str(role)}:
            return role
        case _:
            return None


def _developer_item_as_system(item: ResponseInputItemParam) -> ResponseInputItemParam:
    if "role" not in item or item["role"] != "developer":
        return item
    return EasyInputMessageParam(role="system", content=item["content"], type="message")


def _developer_items_as_system(input: str | ResponseInputParam) -> str | ResponseInputParam:
    if isinstance(input, str):
        return input
    return [_developer_item_as_system(item) for item in input]


def _text_part(part: ResponseInputContentParam) -> str | None:
    match part:
        case {"type": "input_text", "text": str(text)}:
            return text
        case _:
            return None


def _text_only_content(item: ResponseInputItemParam) -> str | None:
    match item:
        case {"role": "system" | "developer", "content": str(text)}:
            return text
        case {"role": "system" | "developer", "content": [*parts]}:
            texts: Final = tuple(map(_text_part, parts))
            return None if any(text is None for text in texts) else "\n\n".join(text for text in texts if text)
        case _:
            return None


def _leading_instruction_block_length(roles: Sequence[str | None]) -> int:
    return next((index for index, role in enumerate(roles) if role not in _INSTRUCTION_ROLES), len(roles))


def _closing_instruction_block_start(roles: Sequence[str | None], leading_length: int) -> int:
    last_conversation_index: Final = next(
        (index for index in range(len(roles) - 1, leading_length - 1, -1) if roles[index] not in _INSTRUCTION_ROLES),
        None,
    )
    if last_conversation_index is None or roles[last_conversation_index] != "assistant":
        return len(roles)
    return last_conversation_index + 1


def _hoisted_indices(roles: Sequence[str | None]) -> tuple[int, ...]:
    leading_length: Final = _leading_instruction_block_length(roles)
    closing_start: Final = _closing_instruction_block_start(roles, leading_length)
    return tuple(
        index for index, role in enumerate(roles[:closing_start]) if index < leading_length or role == "developer"
    )


def _with_instruction_items_folded(
    input: str | ResponseInputParam, instructions: str | None
) -> tuple[str | None, str | ResponseInputParam]:
    if isinstance(input, str):
        return instructions, input
    items: Final = tuple(input)
    folded: Final = MappingProxyType(
        {
            index: text
            for index in _hoisted_indices(tuple(map(_role, items)))
            if (text := _text_only_content(items[index])) is not None
        }
    )
    joined: Final = "\n\n".join(chunk for chunk in (instructions, *folded.values()) if chunk)
    return (
        instructions if not folded else joined or None,
        [  # mutable-ok: the base class takes the input items as a list
            _developer_item_as_system(item) for index, item in enumerate(items) if index not in folded
        ],
    )


class FireworksAIResponsesAPIConfig(OpenAIResponsesAPIConfig):
    @property
    def custom_llm_provider(self) -> LlmProviders:
        return LlmProviders.FIREWORKS_AI

    def validate_environment(
        self,
        headers: Mapping[str, str],
        model: str,
        derouter_params: GenericDeRouterParams | None,
    ) -> dict:  # mutable-ok: overrides the base class signature
        params: Final = derouter_params or GenericDeRouterParams()
        api_key: Final = resolve_fireworks_api_key(params.api_key)
        if api_key is None:
            raise ValueError("FIREWORKS_API_KEY is not set")
        authorized: Final = MappingProxyType(
            {"Content-Type": "application/json", **headers, "Authorization": f"Bearer {api_key}"}
        )
        pinned: Final = with_fireworks_session_affinity(authorized, _session_params(params))
        return dict(pinned)  # mutable-ok: the HTTP handler updates the returned headers in place

    def get_complete_url(self, api_base: str | None, derouter_params: Mapping[str, object]) -> str:
        base: Final = (api_base or get_secret_str("FIREWORKS_API_BASE") or FIREWORKS_AI_DEFAULT_API_BASE).rstrip("/")
        return f"{base}/responses"

    def transform_responses_api_request(
        self,
        model: str,
        input: str | ResponseInputParam,
        response_api_optional_request_params: dict,  # mutable-ok: overrides the base class signature
        derouter_params: GenericDeRouterParams,
        headers: dict,  # mutable-ok: overrides the base class signature
    ) -> dict:  # mutable-ok: overrides the base class signature
        instructions_param: Final[object] = response_api_optional_request_params.get("instructions")
        validated_input: Final = self._validate_input_param(input)
        instructions, folded_input = (
            _with_instruction_items_folded(validated_input, instructions_param)
            if isinstance(instructions_param, str | None)
            else (instructions_param, _developer_items_as_system(validated_input))
        )
        instruction_entries: Final = () if instructions is None else (("instructions", instructions),)
        folded_params: Final = {  # mutable-ok: the base class takes the optional params as a dict
            key: value
            for key, value in (
                *((key, value) for key, value in response_api_optional_request_params.items() if key != "instructions"),
                *instruction_entries,
            )
        }
        return super().transform_responses_api_request(
            model=resolve_fireworks_resource_name(model),
            input=folded_input,
            response_api_optional_request_params=folded_params,
            derouter_params=derouter_params,
            headers=headers,
        )

    def transform_delete_response_api_response(
        self,
        raw_response: httpx.Response,
        logging_obj: "DeRouterLoggingObj",
    ) -> DeleteResponseResult:
        deleted_id: Final = unquote(raw_response.request.url.path.rsplit("/", 1)[-1])
        return DeleteResponseResult(id=deleted_id, object="response", deleted=True)

    def supports_native_websocket(self) -> bool:
        return False

    def supports_native_file_search(self) -> bool:
        return False
