from datetime import timedelta
from typing import Final

from fastapi import HTTPException

import derouter
from derouter.proxy._types import CommonProxyErrors, InvitationNew, UserAPIKeyAuth
from derouter.repositories.table_repositories import InvitationLinkRepository


async def create_invitation_for_user(
    data: InvitationNew,
    user_api_key_dict: UserAPIKeyAuth,
):
    """
    Create an invitation for the user to onboard to DeRouter Admin UI.
    """
    from derouter.proxy.proxy_server import derouter_proxy_admin_name, prisma_client

    if prisma_client is None:
        raise HTTPException(
            status_code=400,
            detail={"error": CommonProxyErrors.db_not_connected_error.value},
        )

    current_time: Final = derouter.utils.get_utc_datetime()
    expires_at: Final = current_time + timedelta(days=7)

    try:
        response: Final = await InvitationLinkRepository(prisma_client).table.create(
            data={
                "user_id": data.user_id,
                "created_at": current_time,
                "expires_at": expires_at,
                "created_by": user_api_key_dict.user_id or derouter_proxy_admin_name,
                "updated_at": current_time,
                "updated_by": user_api_key_dict.user_id or derouter_proxy_admin_name,
            }
        )
        return response
    except Exception as e:
        if "Foreign key constraint failed on the field" in str(e):
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "User id does not exist in 'DeRouter_UserTable'. Fix this by creating user via `/user/new`."
                },
            )
        raise HTTPException(status_code=500, detail={"error": str(e)})
