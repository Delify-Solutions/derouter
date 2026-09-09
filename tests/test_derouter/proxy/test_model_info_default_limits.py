"""
Tests verifying that default_api_key_tpm_limit and default_api_key_rpm_limit set in
derouter_params are returned by the /model/info endpoint.
"""

from typing import Optional
from unittest.mock import MagicMock, patch

import pytest

from derouter.proxy.proxy_server import _get_proxy_model_info
from derouter.types.router import Deployment, DeRouter_Params, ModelInfo


def _make_deployment(
    model_name: str,
    default_tpm: Optional[int] = None,
    default_rpm: Optional[int] = None,
) -> Deployment:
    params: dict = {"model": f"openai/{model_name}"}
    if default_tpm is not None:
        params["default_api_key_tpm_limit"] = default_tpm
    if default_rpm is not None:
        params["default_api_key_rpm_limit"] = default_rpm
    return Deployment(
        model_name=model_name,
        derouter_params=DeRouter_Params(**params),
        model_info=ModelInfo(),
    )


class TestModelInfoDefaultLimitsInResponse:
    """
    Verify _get_proxy_model_info (the helper used by the /model/info endpoint) returns
    default_api_key_tpm_limit and default_api_key_rpm_limit from derouter_params.
    """

    def test_default_tpm_and_rpm_present_in_model_info_response(self):
        """Both defaults should appear in the derouter_params section of the response."""
        deployment = _make_deployment("model1", default_tpm=100, default_rpm=200)
        model_dict = deployment.model_dump(exclude_none=True)

        result = _get_proxy_model_info(model=model_dict)

        derouter_params = result["derouter_params"]
        assert derouter_params.get("default_api_key_tpm_limit") == 100
        assert derouter_params.get("default_api_key_rpm_limit") == 200

    def test_default_tpm_only_present_when_only_tpm_configured(self):
        """Only the configured default appears; the other stays absent."""
        deployment = _make_deployment("model1", default_tpm=500)
        model_dict = deployment.model_dump(exclude_none=True)

        result = _get_proxy_model_info(model=model_dict)

        derouter_params = result["derouter_params"]
        assert derouter_params.get("default_api_key_tpm_limit") == 500
        assert "default_api_key_rpm_limit" not in derouter_params

    def test_default_rpm_only_present_when_only_rpm_configured(self):
        """Only the configured default appears; the other stays absent."""
        deployment = _make_deployment("model1", default_rpm=300)
        model_dict = deployment.model_dump(exclude_none=True)

        result = _get_proxy_model_info(model=model_dict)

        derouter_params = result["derouter_params"]
        assert derouter_params.get("default_api_key_rpm_limit") == 300
        assert "default_api_key_tpm_limit" not in derouter_params

    def test_defaults_absent_when_not_configured(self):
        """Neither field appears when not set on the deployment."""
        deployment = _make_deployment("model1")
        model_dict = deployment.model_dump(exclude_none=True)

        result = _get_proxy_model_info(model=model_dict)

        derouter_params = result["derouter_params"]
        assert "default_api_key_tpm_limit" not in derouter_params
        assert "default_api_key_rpm_limit" not in derouter_params

    def test_defaults_not_masked_or_stripped_by_sensitive_data_filter(self):
        """
        default_api_key_tpm_limit / default_api_key_rpm_limit must not be
        treated as sensitive and must survive remove_sensitive_info_from_deployment.
        They contain "key" which normally triggers masking; the call site explicitly
        excludes these two fields via excluded_keys rather than widening the global
        non_sensitive_overrides.
        """
        deployment = _make_deployment("model1", default_tpm=100, default_rpm=200)
        model_dict = deployment.model_dump(exclude_none=True)

        result = _get_proxy_model_info(model=model_dict)

        # Values should be unchanged integers, not masked strings
        assert result["derouter_params"]["default_api_key_tpm_limit"] == 100
        assert result["derouter_params"]["default_api_key_rpm_limit"] == 200


class TestModelInfoEndpointWithRouter:
    """
    Integration-style tests simulating the /model/info endpoint reading from the router.
    """

    @pytest.mark.asyncio
    async def test_model_info_endpoint_returns_defaults_for_specific_model_id(self):
        """
        When derouter_model_id is provided, the endpoint should return the deployment's
        default limits in derouter_params.
        """
        from derouter.proxy.proxy_server import model_info_v1
        from derouter.proxy._types import UserAPIKeyAuth

        deployment = _make_deployment("model1", default_tpm=100, default_rpm=200)

        mock_router = MagicMock()
        mock_router.get_deployment.return_value = deployment

        user_api_key_dict = UserAPIKeyAuth(api_key="sk-test")

        with (
            patch("derouter.proxy.proxy_server.llm_router", mock_router),
            patch("derouter.proxy.proxy_server.llm_model_list", []),
            patch("derouter.proxy.proxy_server.user_model", None),
        ):
            response = await model_info_v1(
                user_api_key_dict=user_api_key_dict,
                derouter_model_id="some-model-id",
            )

        assert len(response["data"]) == 1
        derouter_params = response["data"][0]["derouter_params"]
        assert derouter_params.get("default_api_key_tpm_limit") == 100
        assert derouter_params.get("default_api_key_rpm_limit") == 200

    @pytest.mark.asyncio
    async def test_model_info_endpoint_returns_defaults_in_full_model_list(self):
        """
        Without derouter_model_id, the endpoint iterates all models. Each deployment's
        default limits should appear in its derouter_params entry.
        """
        from derouter.proxy.proxy_server import model_info_v1
        from derouter.proxy._types import UserAPIKeyAuth

        deployment = _make_deployment("model1", default_tpm=100, default_rpm=200)
        deployment_dict = deployment.model_dump(exclude_none=True)

        mock_router = MagicMock()
        mock_router.model_list = [deployment_dict]
        mock_router.get_model_names.return_value = ["model1"]
        mock_router.get_model_access_groups.return_value = {}

        user_api_key_dict = UserAPIKeyAuth(api_key="sk-test")

        with (
            patch("derouter.proxy.proxy_server.llm_router", mock_router),
            patch("derouter.proxy.proxy_server.llm_model_list", [deployment_dict]),
            patch("derouter.proxy.proxy_server.user_model", None),
            patch("derouter.proxy.proxy_server.prisma_client", None),
            patch("derouter.proxy.proxy_server.get_key_models", return_value=["model1"]),
            patch(
                "derouter.proxy.proxy_server.get_team_models", return_value=["model1"]
            ),
            patch(
                "derouter.proxy.proxy_server.get_complete_model_list",
                return_value=["model1"],
            ),
        ):
            response = await model_info_v1(
                user_api_key_dict=user_api_key_dict,
                derouter_model_id=None,
            )

        assert len(response["data"]) >= 1
        derouter_params = response["data"][0]["derouter_params"]
        assert derouter_params.get("default_api_key_tpm_limit") == 100
        assert derouter_params.get("default_api_key_rpm_limit") == 200
