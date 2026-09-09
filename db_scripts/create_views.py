"""
python script to pre-create all views required by DeRouter Proxy Server
"""

import asyncio

# Enter your DATABASE_URL here

from prisma import Prisma

db = Prisma(
    http={
        "timeout": 60000,
    },
)


async def check_view_exists():
    """
    Checks if the DeRouter_VerificationTokenView and MonthlyGlobalSpend exists in the user's db.

    DeRouter_VerificationTokenView: This view is used for getting the token + team data in user_api_key_auth

    MonthlyGlobalSpend: This view is used for the admin view to see global spend for this month

    If the view doesn't exist, one will be created.
    """

    # connect to dB
    await db.connect()
    try:
        # Try to select one row from the view
        await db.query_raw("""SELECT 1 FROM "DeRouter_VerificationTokenView" LIMIT 1""")
        print("DeRouter_VerificationTokenView Exists!")  # noqa
    except Exception:
        # If an error occurs, the view does not exist, so create it
        await db.execute_raw("""
                CREATE VIEW "DeRouter_VerificationTokenView" AS
                SELECT 
                v.*, 
                t.spend AS team_spend, 
                t.max_budget AS team_max_budget, 
                t.tpm_limit AS team_tpm_limit, 
                t.rpm_limit AS team_rpm_limit
                FROM "DeRouter_VerificationToken" v
                LEFT JOIN "DeRouter_TeamTable" t ON v.team_id = t.team_id;
            """)

        print("DeRouter_VerificationTokenView Created!")  # noqa

    try:
        await db.query_raw("""SELECT 1 FROM "MonthlyGlobalSpend" LIMIT 1""")
        print("MonthlyGlobalSpend Exists!")  # noqa
    except Exception:
        sql_query = """
        CREATE OR REPLACE VIEW "MonthlyGlobalSpend" AS 
        SELECT
        DATE("startTime") AS date, 
        SUM("spend") AS spend 
        FROM 
        "DeRouter_SpendLogs" 
        WHERE 
        "startTime" >= (CURRENT_DATE - INTERVAL '30 days')
        GROUP BY 
        DATE("startTime");
        """
        await db.execute_raw(query=sql_query)

        print("MonthlyGlobalSpend Created!")  # noqa

    try:
        await db.query_raw("""SELECT 1 FROM "Last30dKeysBySpend" LIMIT 1""")
        print("Last30dKeysBySpend Exists!")  # noqa
    except Exception:
        sql_query = """
        CREATE OR REPLACE VIEW "Last30dKeysBySpend" AS
        SELECT 
        L."api_key", 
        V."key_alias",
        V."key_name",
        SUM(L."spend") AS total_spend
        FROM
        "DeRouter_SpendLogs" L
        LEFT JOIN 
        "DeRouter_VerificationToken" V
        ON
        L."api_key" = V."token"
        WHERE
        L."startTime" >= (CURRENT_DATE - INTERVAL '30 days')
        GROUP BY
        L."api_key", V."key_alias", V."key_name"
        ORDER BY
        total_spend DESC;
        """
        await db.execute_raw(query=sql_query)

        print("Last30dKeysBySpend Created!")  # noqa

    try:
        await db.query_raw("""SELECT 1 FROM "Last30dModelsBySpend" LIMIT 1""")
        print("Last30dModelsBySpend Exists!")  # noqa
    except Exception:
        sql_query = """
        CREATE OR REPLACE VIEW "Last30dModelsBySpend" AS
        SELECT
        "model",
        SUM("spend") AS total_spend
        FROM
        "DeRouter_SpendLogs"
        WHERE
        "startTime" >= (CURRENT_DATE - INTERVAL '30 days')
        AND "model" != ''
        GROUP BY
        "model"
        ORDER BY
        total_spend DESC;
        """
        await db.execute_raw(query=sql_query)

        print("Last30dModelsBySpend Created!")  # noqa
    try:
        await db.query_raw("""SELECT 1 FROM "MonthlyGlobalSpendPerKey" LIMIT 1""")
        print("MonthlyGlobalSpendPerKey Exists!")  # noqa
    except Exception:
        sql_query = """
            CREATE OR REPLACE VIEW "MonthlyGlobalSpendPerKey" AS 
            SELECT
            DATE("startTime") AS date, 
            SUM("spend") AS spend,
            api_key as api_key
            FROM 
            "DeRouter_SpendLogs" 
            WHERE 
            "startTime" >= (CURRENT_DATE - INTERVAL '30 days')
            GROUP BY 
            DATE("startTime"),
            api_key;
        """
        await db.execute_raw(query=sql_query)

        print("MonthlyGlobalSpendPerKey Created!")  # noqa
    try:
        await db.query_raw(
            """SELECT 1 FROM "MonthlyGlobalSpendPerUserPerKey" LIMIT 1"""
        )
        print("MonthlyGlobalSpendPerUserPerKey Exists!")  # noqa
    except Exception:
        sql_query = """
            CREATE OR REPLACE VIEW "MonthlyGlobalSpendPerUserPerKey" AS 
            SELECT
            DATE("startTime") AS date, 
            SUM("spend") AS spend,
            api_key as api_key,
            "user" as "user"
            FROM 
            "DeRouter_SpendLogs" 
            WHERE 
            "startTime" >= (CURRENT_DATE - INTERVAL '30 days')
            GROUP BY 
            DATE("startTime"),
            "user",
            api_key;
        """
        await db.execute_raw(query=sql_query)

        print("MonthlyGlobalSpendPerUserPerKey Created!")  # noqa

    try:
        await db.query_raw("""SELECT 1 FROM "DailyTagSpend" LIMIT 1""")
        print("DailyTagSpend Exists!")  # noqa
    except Exception:
        sql_query = """
        CREATE OR REPLACE VIEW "DailyTagSpend" AS
        SELECT
            jsonb_array_elements_text(request_tags) AS individual_request_tag,
            DATE(s."startTime") AS spend_date,
            COUNT(*) AS log_count,
            SUM(spend) AS total_spend
        FROM "DeRouter_SpendLogs" s
        GROUP BY individual_request_tag, DATE(s."startTime");
        """
        await db.execute_raw(query=sql_query)

        print("DailyTagSpend Created!")  # noqa

    try:
        await db.query_raw("""SELECT 1 FROM "Last30dTopEndUsersSpend" LIMIT 1""")
        print("Last30dTopEndUsersSpend Exists!")  # noqa
    except Exception:
        sql_query = """
        CREATE VIEW "Last30dTopEndUsersSpend" AS
        SELECT end_user, COUNT(*) AS total_events, SUM(spend) AS total_spend
        FROM "DeRouter_SpendLogs"
        WHERE end_user <> '' AND end_user <> user
        AND "startTime" >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY end_user
        ORDER BY total_spend DESC
        LIMIT 100;
        """
        await db.execute_raw(query=sql_query)

        print("Last30dTopEndUsersSpend Created!")  # noqa

    return


asyncio.run(check_view_exists())
