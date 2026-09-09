from typing import TYPE_CHECKING, Any, Final

from typing_extensions import TypedDict

from derouter.types.utils import StandardLoggingPayload

if TYPE_CHECKING:
    from derouter.llms.vertex_ai.vertex_llm_base import VertexBase
else:
    VertexBase = Any


GCS_DEFAULT_BATCH_SIZE: Final = 2048
GCS_DEFAULT_FLUSH_INTERVAL_SECONDS: Final = 20
GCS_DEFAULT_USE_BATCHED_LOGGING: Final = True


class GCSLoggingConfig(TypedDict):
    """
    Internal DeRouter Config for GCS Bucket logging
    """

    bucket_name: str
    vertex_instance: VertexBase
    path_service_account: str | None


class GCSLogQueueItem(TypedDict):
    """
    Internal Type, used for queueing logs to be sent to GCS Bucket
    """

    payload: StandardLoggingPayload
    kwargs: dict[str, Any]
    response_obj: Any | None
