from typing import Final

from fastapi import Request
from fastapi_sso.sso.base import OpenID

from derouter.integrations.custom_logger import CustomLogger


class CustomSSOLoginHandler(CustomLogger):
    """
    Custom logger for the UI SSO sign in

    Use this to parse the request headers and return a OpenID object

    Useful when you have an OAuth proxy in front of DeRouter
    and you want to use the headers from the proxy to sign in the user
    """

    async def handle_custom_ui_sso_sign_in(
        self,
        request: Request,
    ) -> OpenID:
        from derouter.proxy.auth.trusted_proxy_utils import (
            require_trusted_proxy_request,
        )
        from derouter.proxy.proxy_server import general_settings

        require_trusted_proxy_request(
            request=request,
            general_settings=general_settings,
            feature_name="Custom UI SSO",
        )

        request_headers_dict: Final = dict(request.headers)
        return OpenID(
            id=request_headers_dict.get("x-derouter-user-id"),
            email=request_headers_dict.get("x-derouter-user-email"),
            first_name="Test",
            last_name="Test",
            display_name="Test",
            picture="https://test.com/test.png",
            provider="test",
        )
