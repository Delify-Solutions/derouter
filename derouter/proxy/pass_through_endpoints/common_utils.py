from typing import Final

from fastapi import Request


def get_derouter_virtual_key(request: Request) -> str:
    """
    Extract and format API key from request headers.
    Prioritizes x-derouter-api-key over Authorization header.


    Vertex JS SDK uses `Authorization` header, we use `x-derouter-api-key` to pass derouter virtual key

    """
    derouter_api_key: Final = request.headers.get("x-derouter-api-key")
    if derouter_api_key:
        return f"Bearer {derouter_api_key}"
    return request.headers.get("Authorization", "")
