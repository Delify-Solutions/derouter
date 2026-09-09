from prisma import Prisma
from derouter._logging import verbose_logger


async def apply_db_fixes(db: Prisma):
    """
    Do Not Run this in production, only use it as a one-time fix
    """
    verbose_logger.warning(
        "DO NOT run this in Production....Running update_unassigned_teams"
    )
    try:
        sql_query = """
            UPDATE "DeRouter_SpendLogs"
            SET team_id = (
                SELECT vt.team_id
                FROM "DeRouter_VerificationToken" vt
                WHERE vt.token = "DeRouter_SpendLogs".api_key
            )
            WHERE team_id IS NULL
            AND EXISTS (
                SELECT 1
                FROM "DeRouter_VerificationToken" vt
                WHERE vt.token = "DeRouter_SpendLogs".api_key
            );
        """
        response = await db.query_raw(sql_query)
        print(
            "Updated unassigned teams, Response=%s",
            response,
        )
    except Exception as e:
        raise Exception(f"Error apply_db_fixes: {str(e)}")
    return
