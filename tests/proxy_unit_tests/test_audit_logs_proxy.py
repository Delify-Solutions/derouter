import os
import traceback
from derouter._uuid import uuid
from datetime import datetime

from dotenv import load_dotenv
from fastapi import Request
from fastapi.routing import APIRoute


import io
import time

# this file is to test derouter/proxy

import asyncio
import logging

load_dotenv()

import pytest
import derouter
from derouter._logging import verbose_proxy_logger

from derouter.proxy.proxy_server import (
    LitellmUserRoles,
    audio_transcriptions,
    chat_completion,
    completion,
    embeddings,
    model_list,
    moderations,
    user_api_key_auth,
)

from derouter.proxy.utils import PrismaClient, ProxyLogging, hash_token, update_spend

verbose_proxy_logger.setLevel(level=logging.DEBUG)

from starlette.datastructures import URL

from derouter.proxy.management_helpers.audit_logs import (
    create_audit_log_for_update,
    get_audit_log_changed_by,
)
from derouter.proxy._types import DeRouter_AuditLogs, LitellmTableNames, UserAPIKeyAuth
from derouter.caching.caching import DualCache
from unittest.mock import patch, AsyncMock

proxy_logging_obj = ProxyLogging(user_api_key_cache=DualCache())
import json


def test_get_audit_log_changed_by_prefers_authenticated_user():
    user_api_key_dict = UserAPIKeyAuth(
        api_key="test-key",
        user_id="authenticated-user",
    )

    assert (
        get_audit_log_changed_by(
            derouter_changed_by="spoofed-user",
            user_api_key_dict=user_api_key_dict,
            derouter_proxy_admin_name="proxy-admin",
        )
        == "authenticated-user"
    )


def test_get_audit_log_changed_by_honors_header_with_admin_opt_in():
    user_api_key_dict = UserAPIKeyAuth(
        api_key="test-key",
        user_id="service-account",
        metadata={"allow_derouter_changed_by_header": True},
    )

    assert (
        get_audit_log_changed_by(
            derouter_changed_by="delegated-user",
            user_api_key_dict=user_api_key_dict,
            derouter_proxy_admin_name="proxy-admin",
        )
        == "delegated-user"
    )


def test_get_audit_log_changed_by_honors_header_with_team_opt_in():
    user_api_key_dict = UserAPIKeyAuth(
        api_key="test-key",
        user_id="service-account",
        team_metadata={"allow_derouter_changed_by_header": True},
    )

    assert (
        get_audit_log_changed_by(
            derouter_changed_by="delegated-user",
            user_api_key_dict=user_api_key_dict,
            derouter_proxy_admin_name="proxy-admin",
        )
        == "delegated-user"
    )


def test_get_audit_log_changed_by_ignores_header_without_opt_in_when_user_id_missing():
    user_api_key_dict = UserAPIKeyAuth(api_key="test-key")

    assert (
        get_audit_log_changed_by(
            derouter_changed_by="spoofed-user",
            user_api_key_dict=user_api_key_dict,
            derouter_proxy_admin_name="proxy-admin",
        )
        == "proxy-admin"
    )


def test_get_audit_log_changed_by_honors_header_with_opt_in_when_user_id_missing():
    user_api_key_dict = UserAPIKeyAuth(
        api_key="test-key",
        metadata={"allow_derouter_changed_by_header": True},
    )

    assert (
        get_audit_log_changed_by(
            derouter_changed_by="delegated-user",
            user_api_key_dict=user_api_key_dict,
            derouter_proxy_admin_name="proxy-admin",
        )
        == "delegated-user"
    )


@pytest.mark.asyncio
async def test_create_internal_user_audit_log_uses_changed_by_helper():
    from derouter.proxy.hooks.user_management_event_hooks import UserManagementEventHooks

    user_api_key_dict = UserAPIKeyAuth(
        api_key="test-key",
        user_id="service-account",
        metadata={"allow_derouter_changed_by_header": True},
    )

    with (
        patch("derouter.store_audit_logs", True),
        patch(
            "derouter.proxy.hooks.user_management_event_hooks.create_audit_log_for_update",
            new_callable=AsyncMock,
        ) as mock_create_audit_log_for_update,
    ):
        await UserManagementEventHooks.create_internal_user_audit_log(
            user_id="target-user",
            action="updated",
            derouter_changed_by="delegated-user",
            user_api_key_dict=user_api_key_dict,
            derouter_proxy_admin_name="proxy-admin",
            before_value='{"before": true}',
            after_value='{"after": true}',
        )

    request_data = mock_create_audit_log_for_update.await_args.kwargs["request_data"]
    assert request_data.changed_by == "delegated-user"
    assert request_data.changed_by_api_key == "test-key"
    assert request_data.object_id == "target-user"
    assert request_data.action == "updated"


@pytest.mark.asyncio
async def test_create_audit_log_for_update_premium_user():
    """
    Basic unit test for create_audit_log_for_update

    Test that the audit log is created when a premium user updates a team
    """
    with (
        patch("derouter.proxy.proxy_server.premium_user", True),
        patch("derouter.store_audit_logs", True),
        patch("derouter.proxy.proxy_server.prisma_client") as mock_prisma,
    ):

        mock_prisma.db.derouter_auditlog.create = AsyncMock()

        request_data = DeRouter_AuditLogs(
            id="test_id",
            updated_at=datetime.now(),
            changed_by="test_changed_by",
            action="updated",
            table_name=LitellmTableNames.TEAM_TABLE_NAME,
            object_id="test_object_id",
            updated_values=json.dumps({"key": "value"}),
            before_value=json.dumps({"old_key": "old_value"}),
        )

        await create_audit_log_for_update(request_data)

        mock_prisma.db.derouter_auditlog.create.assert_called_once_with(
            data={
                "id": "test_id",
                "updated_at": request_data.updated_at,
                "changed_by": request_data.changed_by,
                "action": request_data.action,
                "table_name": request_data.table_name,
                "object_id": request_data.object_id,
                "updated_values": request_data.updated_values,
                "before_value": request_data.before_value,
            }
        )


@pytest.fixture
def prisma_client():
    from derouter.proxy.proxy_cli import append_query_params

    ### add connection pool + pool timeout args
    params = {"connection_limit": 100, "pool_timeout": 60}
    database_url = os.getenv("DATABASE_URL")
    modified_url = append_query_params(database_url, params)
    os.environ["DATABASE_URL"] = modified_url

    # Assuming PrismaClient is a class that needs to be instantiated
    prisma_client = PrismaClient(
        database_url=os.environ["DATABASE_URL"], proxy_logging_obj=proxy_logging_obj
    )

    return prisma_client


@pytest.mark.skip(reason="Requires reliable external DB connection (prisma).")
@pytest.mark.asyncio()
async def test_create_audit_log_in_db(prisma_client):
    print("prisma client=", prisma_client)

    setattr(derouter.proxy.proxy_server, "prisma_client", prisma_client)
    setattr(derouter.proxy.proxy_server, "master_key", "sk-1234")
    setattr(derouter.proxy.proxy_server, "premium_user", True)
    setattr(derouter, "store_audit_logs", True)

    await derouter.proxy.proxy_server.prisma_client.connect()
    audit_log_id = f"audit_log_id_{uuid.uuid4()}"

    # create a audit log for /key/generate
    request_data = DeRouter_AuditLogs(
        id=audit_log_id,
        updated_at=datetime.now(),
        changed_by="test_changed_by",
        action="updated",
        table_name=LitellmTableNames.TEAM_TABLE_NAME,
        object_id="test_object_id",
        updated_values=json.dumps({"key": "value"}),
        before_value=json.dumps({"old_key": "old_value"}),
    )

    await create_audit_log_for_update(request_data)

    await asyncio.sleep(1)

    # now read the last log from the db
    last_log = await prisma_client.db.derouter_auditlog.find_first(
        where={"id": audit_log_id}
    )

    assert last_log.id == audit_log_id

    setattr(derouter, "store_audit_logs", False)
