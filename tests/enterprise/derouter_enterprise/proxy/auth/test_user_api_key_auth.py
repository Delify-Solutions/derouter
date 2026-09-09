from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import Request
from derouter_enterprise.proxy.auth.user_api_key_auth import enterprise_custom_auth

from derouter.proxy._types import UserAPIKeyAuth


@pytest.mark.asyncio
async def test_enterprise_custom_auth_none_user_auth():
    # Test when user_custom_auth is None
    request = MagicMock(spec=Request)
    result = await enterprise_custom_auth(request, "test-api-key", None)
    assert result is None


@pytest.mark.asyncio
async def test_enterprise_custom_auth_mode_on():
    # Test when mode is "on"
    mock_user_auth = AsyncMock(return_value={"user_id": "test-user"})
    request = MagicMock(spec=Request)

    with patch(
        "derouter_enterprise.proxy.proxy_server.custom_auth_settings", {"mode": "on"}
    ):
        result = await enterprise_custom_auth(request, "test-api-key", mock_user_auth)
        assert result == {"user_id": "test-user"}
        mock_user_auth.assert_called_once_with(request, "test-api-key")


@pytest.mark.asyncio
async def test_enterprise_custom_auth_mode_auto_with_error():
    # Test when mode is "auto" and user_auth raises an exception
    mock_user_auth = AsyncMock(side_effect=Exception("Auth failed"))
    request = MagicMock(spec=Request)

    with patch(
        "derouter_enterprise.proxy.proxy_server.custom_auth_settings", {"mode": "auto"}
    ):
        result = await enterprise_custom_auth(request, "test-api-key", mock_user_auth)
        assert result is None
        mock_user_auth.assert_called_once_with(request, "test-api-key")


@pytest.mark.asyncio
async def test_enterprise_custom_auth_returns_string():
    from derouter.proxy._types import hash_token

    # Test when enterprise_custom_auth returns a string (DeRouter virtual key)
    mock_user_auth = AsyncMock(return_value="sk-test-key")
    request = MagicMock(spec=Request)

    with (
        patch(
            "derouter.proxy.auth.user_api_key_auth.enterprise_custom_auth",
            mock_user_auth,
        ),
        patch("derouter.proxy.proxy_server.master_key", "sk-1234"),
        patch("derouter.proxy.proxy_server.prisma_client", MagicMock()),
    ):
        # Verify the key is correctly handled in _user_api_key_auth_builder
        with patch(
            "derouter.proxy.auth.resolvers.store.IdentityStore._resolve_key"
        ) as mock_get_key_object:
            mock_get_key_object.return_value = UserAPIKeyAuth(
                token="sk-test-key",
                user_role="internal_user",
                team_id=None,
                user_id="test-user",
            )

            # Call _user_api_key_auth_builder with the returned key
            from derouter.proxy.auth.user_api_key_auth import _user_api_key_auth_builder

            try:
                auth_obj = await _user_api_key_auth_builder(
                    request=request,
                    api_key="my-custom-key",
                    azure_api_key_header="",
                    anthropic_api_key_header=None,
                    google_ai_studio_api_key_header=None,
                    azure_apim_header=None,
                    request_data={},
                    custom_derouter_key_header=None,
                )
            except Exception as e:
                print("error:", e)

            # Verify the key lookup was called with the correct hashed key
            mock_get_key_object.assert_called_once()
            # The key should be hashed before being passed to the resolver
            assert mock_get_key_object.call_args[0][0] == hash_token("sk-test-key")
