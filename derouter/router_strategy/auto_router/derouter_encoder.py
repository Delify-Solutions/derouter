from typing import TYPE_CHECKING, Any, Final, Optional

from pydantic import ConfigDict
from semantic_router.encoders import DenseEncoder
from semantic_router.encoders.base import AsymmetricDenseMixin

import derouter
from derouter._logging import verbose_router_logger

if TYPE_CHECKING:
    from derouter.router import Router
else:
    Router = Any


def derouter_to_list(embeds: derouter.EmbeddingResponse) -> list[list[float]]:
    """Convert a DeRouter embedding response to a list of embeddings.

    :param embeds: The DeRouter embedding response.
    :return: A list of embeddings.
    """
    if not embeds or not isinstance(embeds, derouter.EmbeddingResponse) or not embeds.data:
        raise ValueError("No embeddings found in DeRouter embedding response.")
    return [x["embedding"] for x in embeds.data]


class CustomDenseEncoder(DenseEncoder):
    model_config = ConfigDict(extra="allow")

    def __init__(self, derouter_router_instance: Optional["Router"] = None, **kwargs):
        # Extract derouter_router_instance from kwargs if passed there
        if "derouter_router_instance" in kwargs:
            derouter_router_instance = kwargs.pop("derouter_router_instance")

        super().__init__(**kwargs)
        self.derouter_router_instance = derouter_router_instance


class DeRouterRouterEncoder(CustomDenseEncoder, AsymmetricDenseMixin):
    """DeRouter encoder class for generating embeddings using DeRouter.

    The DeRouterRouterEncoder class is a subclass of DenseEncoder and utilizes the DeRouter Router SDK
    to generate embeddings for given documents. It supports all encoders supported by DeRouter
    and supports customization of the score threshold for filtering or processing the embeddings.
    """

    type: str = "internal_derouter_router"

    def __init__(
        self,
        derouter_router_instance: "Router",
        model_name: str,
        score_threshold: float | None = None,
        max_input_chars: int = 0,
    ):
        """Initialize the DeRouterEncoder.

        :param derouter_router_instance: The instance of the DeRouter Router.
        :type derouter_router_instance: Router
        :param model_name: The name of the embedding model to use. Must use DeRouter naming
            convention (e.g. "openai/text-embedding-3-small" or "mistral/mistral-embed").
        :type model_name: str
        :param score_threshold: The score threshold for the embeddings.
        :type score_threshold: float
        :param max_input_chars: Longest doc, in characters, sent to the embedding model; anything
            longer is cut to this length. Opt-in, defaulting to 0 (send docs whole), because a
            caller that has to see the entire text to be correct must not be cut silently: a
            semantic guard that inspects only a prefix can be walked past with a benign opener.
            Callers that only rank text against short utterances, such as the auto-router, pass a
            limit so the encoder's context window cannot fail their request.
        :type max_input_chars: int
        """
        super().__init__(
            name=model_name,
            score_threshold=score_threshold if score_threshold is not None else 0.3,
        )
        self.model_name = model_name
        self.derouter_router_instance = derouter_router_instance
        self.max_input_chars = max_input_chars

    def _clamp(self, docs: list[str]) -> list[str]:  # mutable-ok: embedding() takes `input: str | list`
        """Cut every doc to `max_input_chars`, keeping the head, or return them whole when unset.

        The head carries the ask often enough to place it against a route, and a cut prompt still
        routes where an over-long one just errors out.
        """
        limit: Final = self.max_input_chars
        if limit <= 0:
            return docs
        clamped: Final = [doc[:limit] for doc in docs]  # mutable-ok: embedding() takes `input: str | list`
        if clamped != docs:
            verbose_router_logger.debug(
                "DeRouterRouterEncoder: cut input to %s chars for embedding model %s", limit, self.model_name
            )
        return clamped

    def __call__(self, docs: list[Any], **kwargs) -> list[list[float]]:
        """Encode a list of text documents into embeddings using DeRouter.

        :param docs: List of text documents to encode.
        :return: List of embeddings for each document."""
        return self.encode_queries(docs, **kwargs)

    async def acall(self, docs: list[Any], **kwargs) -> list[list[float]]:
        """Encode a list of documents into embeddings using DeRouter asynchronously.

        :param docs: List of documents to encode.
        :return: List of embeddings for each document."""
        return await self.aencode_queries(docs, **kwargs)

    def encode_queries(self, docs: list[str], **kwargs) -> list[list[float]]:
        if self.derouter_router_instance is None:
            raise ValueError("derouter_router_instance is not set")
        try:
            embeds: Final = self.derouter_router_instance.embedding(
                input=self._clamp(docs), model=self.model_name, **kwargs
            )
            return derouter_to_list(embeds)
        except Exception as e:
            raise ValueError(f"{self.type.capitalize()} API call failed. Error: {e}") from e

    def encode_documents(self, docs: list[str], **kwargs) -> list[list[float]]:
        if self.derouter_router_instance is None:
            raise ValueError("derouter_router_instance is not set")
        try:
            embeds: Final = self.derouter_router_instance.embedding(
                input=self._clamp(docs), model=self.model_name, **kwargs
            )
            return derouter_to_list(embeds)
        except Exception as e:
            raise ValueError(f"{self.type.capitalize()} API call failed. Error: {e}") from e

    async def aencode_queries(self, docs: list[str], **kwargs) -> list[list[float]]:
        if self.derouter_router_instance is None:
            raise ValueError("derouter_router_instance is not set")
        try:
            embeds: Final = await self.derouter_router_instance.aembedding(
                input=self._clamp(docs), model=self.model_name, **kwargs
            )
            return derouter_to_list(embeds)
        except Exception as e:
            raise ValueError(f"{self.type.capitalize()} API call failed. Error: {e}") from e

    async def aencode_documents(self, docs: list[str], **kwargs) -> list[list[float]]:
        if self.derouter_router_instance is None:
            raise ValueError("derouter_router_instance is not set")
        try:
            embeds: Final = await self.derouter_router_instance.aembedding(
                input=self._clamp(docs), model=self.model_name, **kwargs
            )
            return derouter_to_list(embeds)
        except Exception as e:
            raise ValueError(f"{self.type.capitalize()} API call failed. Error: {e}") from e
