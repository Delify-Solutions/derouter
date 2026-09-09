"""
Passthrough table repositories.

Each repository centralizes access to a single Prisma table behind a ``table``
property, making the repository the one place that names the underlying table.
These are thin wrappers for tables that do not (yet) need domain-specific query
methods; richer repositories live in their own modules.
"""

from typing import TYPE_CHECKING, Any, Final, Generic

from derouter.proxy.common_utils.config_sync_pubsub import wrap_table_actions_for_config_sync
from derouter.repositories.prisma_protocols import RowT_co, TableActions

if TYPE_CHECKING:
    from prisma import models as prisma_models  # noqa: F401  # used by quoted base-class subscripts


class PrismaTableRepository(Generic[RowT_co]):
    """Base for repositories that expose a single Prisma table."""

    table_name: str

    def __init__(self, prisma_client: object):
        self._prisma_client = prisma_client

    @property
    def prisma_client(self) -> Any:
        if self._prisma_client is None:
            raise RuntimeError("No DB Connected. See - https://router.delify.vn/docs/proxy/virtual_keys")
        return self._prisma_client

    @property
    def table(self) -> TableActions[RowT_co]:
        actions: Final[TableActions[RowT_co]] = getattr(self.prisma_client.db, self.table_name)
        return wrap_table_actions_for_config_sync(actions=actions, table_name=self.table_name)


class PolicyRepository(PrismaTableRepository["prisma_models.DeRouter_PolicyTable"]):
    table_name = "derouter_policytable"


class AgentsRepository(PrismaTableRepository["prisma_models.DeRouter_AgentsTable"]):
    table_name = "derouter_agentstable"


class ObjectPermissionRepository(PrismaTableRepository["prisma_models.DeRouter_ObjectPermissionTable"]):
    table_name = "derouter_objectpermissiontable"


class GuardrailsRepository(PrismaTableRepository["prisma_models.DeRouter_GuardrailsTable"]):
    table_name = "derouter_guardrailstable"


class MCPServerRepository(PrismaTableRepository["prisma_models.DeRouter_MCPServerTable"]):
    table_name = "derouter_mcpservertable"


class ManagedObjectRepository(PrismaTableRepository["prisma_models.DeRouter_ManagedObjectTable"]):
    table_name = "derouter_managedobjecttable"


class OrganizationMembershipRepository(PrismaTableRepository["prisma_models.DeRouter_OrganizationMembership"]):
    table_name = "derouter_organizationmembership"


class SpendLogsRepository(PrismaTableRepository["prisma_models.DeRouter_SpendLogs"]):
    table_name = "derouter_spendlogs"


class BudgetWindowSpendRepository(PrismaTableRepository["prisma_models.DeRouter_BudgetWindowSpend"]):
    table_name = "derouter_budgetwindowspend"


class ClaudeCodePluginRepository(PrismaTableRepository["prisma_models.DeRouter_ClaudeCodePluginTable"]):
    table_name = "derouter_claudecodeplugintable"


class TeamMembershipRepository(PrismaTableRepository["prisma_models.DeRouter_TeamMembership"]):
    table_name = "derouter_teammembership"


class EndUserRepository(PrismaTableRepository["prisma_models.DeRouter_EndUserTable"]):
    table_name = "derouter_endusertable"


class ManagedVectorStoresRepository(PrismaTableRepository["prisma_models.DeRouter_ManagedVectorStoresTable"]):
    table_name = "derouter_managedvectorstorestable"


class MCPUserCredentialsRepository(PrismaTableRepository["prisma_models.DeRouter_MCPUserCredentials"]):
    table_name = "derouter_mcpusercredentials"


class MCPServerOAuthClientRepository(PrismaTableRepository["prisma_models.DeRouter_MCPServerOAuthClient"]):
    table_name = "derouter_mcpserveroauthclient"


class PromptRepository(PrismaTableRepository["prisma_models.DeRouter_PromptTable"]):
    table_name = "derouter_prompttable"


class TagRepository(PrismaTableRepository["prisma_models.DeRouter_TagTable"]):
    table_name = "derouter_tagtable"


class ModelAccessGroupBudgetRepository(PrismaTableRepository["prisma_models.DeRouter_ModelAccessGroupBudgetTable"]):
    table_name = "derouter_modelaccessgroupbudgettable"


class InvitationLinkRepository(PrismaTableRepository["prisma_models.DeRouter_InvitationLink"]):
    table_name = "derouter_invitationlink"


class JWTKeyMappingRepository(PrismaTableRepository["prisma_models.DeRouter_JWTKeyMapping"]):
    table_name = "derouter_jwtkeymapping"


class ManagedFileRepository(PrismaTableRepository["prisma_models.DeRouter_ManagedFileTable"]):
    table_name = "derouter_managedfiletable"


class MemoryRepository(PrismaTableRepository["prisma_models.DeRouter_MemoryTable"]):
    table_name = "derouter_memorytable"


class SearchToolsRepository(PrismaTableRepository["prisma_models.DeRouter_SearchToolsTable"]):
    table_name = "derouter_searchtoolstable"


class ConfigOverridesRepository(PrismaTableRepository["prisma_models.DeRouter_ConfigOverrides"]):
    table_name = "derouter_configoverrides"


class MCPToolsetRepository(PrismaTableRepository["prisma_models.DeRouter_MCPToolsetTable"]):
    table_name = "derouter_mcptoolsettable"


class ToolRepository(PrismaTableRepository["prisma_models.DeRouter_ToolTable"]):
    table_name = "derouter_tooltable"


class DeletedVerificationTokenRepository(PrismaTableRepository["prisma_models.DeRouter_DeletedVerificationToken"]):
    table_name = "derouter_deletedverificationtoken"


class WorkflowRunRepository(PrismaTableRepository["prisma_models.DeRouter_WorkflowRun"]):
    table_name = "derouter_workflowrun"


class ModelTableRepository(PrismaTableRepository["prisma_models.DeRouter_ModelTable"]):
    table_name = "derouter_modeltable"


class AccessGroupRepository(PrismaTableRepository["prisma_models.DeRouter_AccessGroupTable"]):
    table_name = "derouter_accessgrouptable"


class SSOConfigRepository(PrismaTableRepository["prisma_models.DeRouter_SSOConfig"]):
    table_name = "derouter_ssoconfig"


class UISettingsRepository(PrismaTableRepository["prisma_models.DeRouter_UISettings"]):
    table_name = "derouter_uisettings"


class DailyGuardrailMetricsRepository(PrismaTableRepository["prisma_models.DeRouter_DailyGuardrailMetrics"]):
    table_name = "derouter_dailyguardrailmetrics"


class DailyGuardrailUsageUnitsRepository(PrismaTableRepository["prisma_models.DeRouter_DailyGuardrailUsageUnits"]):
    table_name = "derouter_dailyguardrailusageunits"


class PolicyAttachmentRepository(PrismaTableRepository["prisma_models.DeRouter_PolicyAttachmentTable"]):
    table_name = "derouter_policyattachmenttable"


class TeamRepository(PrismaTableRepository["prisma_models.DeRouter_TeamTable"]):
    table_name = "derouter_teamtable"


class DeletedTeamRepository(PrismaTableRepository["prisma_models.DeRouter_DeletedTeamTable"]):
    table_name = "derouter_deletedteamtable"


class SkillsRepository(PrismaTableRepository["prisma_models.DeRouter_SkillsTable"]):
    table_name = "derouter_skillstable"


class CacheConfigRepository(PrismaTableRepository["prisma_models.DeRouter_CacheConfig"]):
    table_name = "derouter_cacheconfig"


class ManagedVectorStoreIndexRepository(PrismaTableRepository["prisma_models.DeRouter_ManagedVectorStoreIndexTable"]):
    table_name = "derouter_managedvectorstoreindextable"


class WorkflowMessageRepository(PrismaTableRepository["prisma_models.DeRouter_WorkflowMessage"]):
    table_name = "derouter_workflowmessage"


class DailyTagSpendRepository(PrismaTableRepository["prisma_models.DeRouter_DailyTagSpend"]):
    table_name = "derouter_dailytagspend"


class SpendLogToolIndexRepository(PrismaTableRepository["prisma_models.DeRouter_SpendLogToolIndex"]):
    table_name = "derouter_spendlogtoolindex"


class DailyToolSpendRepository(PrismaTableRepository["prisma_models.DeRouter_DailyToolSpend"]):
    table_name = "derouter_dailytoolspend"


class SpendLogGuardrailIndexRepository(PrismaTableRepository["prisma_models.DeRouter_SpendLogGuardrailIndex"]):
    table_name = "derouter_spendlogguardrailindex"


class UserNotificationsRepository(PrismaTableRepository["prisma_models.DeRouter_UserNotifications"]):
    table_name = "derouter_usernotifications"


class HealthCheckRepository(PrismaTableRepository["prisma_models.DeRouter_HealthCheckTable"]):
    table_name = "derouter_healthchecktable"


class DeprecatedVerificationTokenRepository(PrismaTableRepository["prisma_models.DeRouter_DeprecatedVerificationToken"]):
    table_name = "derouter_deprecatedverificationtoken"


class WorkflowEventRepository(PrismaTableRepository["prisma_models.DeRouter_WorkflowEvent"]):
    table_name = "derouter_workflowevent"


class DailyPolicyMetricsRepository(PrismaTableRepository["prisma_models.DeRouter_DailyPolicyMetrics"]):
    table_name = "derouter_dailypolicymetrics"


class AdaptiveRouterStateRepository(PrismaTableRepository["prisma_models.DeRouter_AdaptiveRouterState"]):
    table_name = "derouter_adaptiverouterstate"


class AuditLogRepository(PrismaTableRepository["prisma_models.DeRouter_AuditLog"]):
    table_name = "derouter_auditlog"


class AdaptiveRouterSessionRepository(PrismaTableRepository["prisma_models.DeRouter_AdaptiveRouterSession"]):
    table_name = "derouter_adaptiveroutersession"
