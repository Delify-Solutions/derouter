from typing import Any, Final

from derouter.a2a_protocol.utils import (
    get_session_id_from_a2a_params,
    scope_session_to_principal,
)


def merge_a2a_session_into_derouter_params(
    derouter_params: dict[str, Any],
    params: dict[str, Any],
    principal: str | None = None,
) -> dict[str, Any]:
    merged: Final = dict(derouter_params)
    session_id: Final = get_session_id_from_a2a_params(params)
    if session_id and "session_id" not in merged:
        merged["session_id"] = scope_session_to_principal(session_id, principal)
    return merged
