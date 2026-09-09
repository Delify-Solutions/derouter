import pytest
from typing import List, cast

import derouter
from derouter.llms.vertex_ai.gemini.transformation import (
    _gemini_convert_messages_with_history,
)
from derouter.types.llms.openai import AllMessageValues


def test_missing_image_url_field_raises_bad_request_error():
    """When element type is 'image_url' but 'image_url' field is missing, a BadRequestError is raised."""
    messages = cast(
        List[AllMessageValues],
        [{"role": "user", "content": [{"type": "image_url"}]}],
    )
    with pytest.raises(derouter.BadRequestError) as exc_info:
        _gemini_convert_messages_with_history(messages, model="gemini-1.5-pro")
    assert "'image_url' field is missing" in str(exc_info.value)


def test_missing_url_inside_image_url_dict_raises_bad_request_error():
    """When image_url is a dict but 'url' key is absent, a BadRequestError is raised."""
    messages = cast(
        List[AllMessageValues],
        [{"role": "user", "content": [{"type": "image_url", "image_url": {"detail": "high"}}]}],
    )
    with pytest.raises(derouter.BadRequestError) as exc_info:
        _gemini_convert_messages_with_history(messages, model="gemini-1.5-pro")
    assert "'url' field is missing inside" in str(exc_info.value)


def test_explicit_null_image_url_raises_bad_request_error():
    """When image_url key is present but explicitly null, a BadRequestError is raised."""
    messages = cast(
        List[AllMessageValues],
        [{"role": "user", "content": [{"type": "image_url", "image_url": None}]}],
    )
    with pytest.raises(derouter.BadRequestError) as exc_info:
        _gemini_convert_messages_with_history(messages, model="gemini-1.5-pro")
    assert "'image_url' field is missing" in str(exc_info.value)


def test_empty_dict_image_url_raises_bad_request_error():
    """When image_url is an empty dict (no url), a BadRequestError is raised."""
    messages = cast(
        List[AllMessageValues],
        [{"role": "user", "content": [{"type": "image_url", "image_url": {}}]}],
    )
    with pytest.raises(derouter.BadRequestError) as exc_info:
        _gemini_convert_messages_with_history(messages, model="gemini-1.5-pro")
    assert "'url' field is missing inside" in str(exc_info.value)
