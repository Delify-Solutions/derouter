from io import BufferedReader
from typing import TYPE_CHECKING, Any, Final, cast

from httpx._types import RequestFiles

import derouter
from derouter.images.utils import ImageEditRequestUtils
from derouter.types.images.main import ImageEditRequestParams
from derouter.types.llms.openai import FileTypes
from derouter.types.router import GenericDeRouterParams

from .transformation import OpenAIImageEditConfig

if TYPE_CHECKING:
    from derouter.derouter_core_utils.derouter_logging import Logging as _DeRouterLoggingObj

    DeRouterLoggingObj = _DeRouterLoggingObj
else:
    DeRouterLoggingObj = Any


class DallE2ImageEditConfig(OpenAIImageEditConfig):
    """
    DALL-E-2 specific configuration for image edit API.

    DALL-E-2 only supports editing a single image (not an array).
    Uses "image" field name instead of "image[]".
    """

    def transform_image_edit_request(
        self,
        model: str,
        prompt: str | None,
        image: FileTypes | None,
        image_edit_optional_request_params: dict,
        derouter_params: GenericDeRouterParams,
        headers: dict,
    ) -> tuple[dict, RequestFiles]:
        """
        Transform image edit request for DALL-E-2.

        DALL-E-2 only accepts a single image with field name "image" (not "image[]").
        """
        request_params: Final = {
            "model": model,
            **image_edit_optional_request_params,
        }
        if image is not None:
            request_params["image"] = image
        if prompt is not None:
            request_params["prompt"] = prompt

        request: Final = ImageEditRequestParams(**request_params)
        request_dict: Final = cast(dict, request)

        #########################################################
        # Separate images and masks as `files` and send other parameters as `data`
        #########################################################
        _image_list: Final = request_dict.get("image")
        _mask = request_dict.get("mask")
        data_without_files: Final = {k: v for k, v in request_dict.items() if k not in ["image", "mask"]}
        files_list: Final[list[tuple[str, Any]]] = []

        # Handle image parameter - DALL-E-2 only supports single image
        if _image_list is not None:
            image_list: Final = [_image_list] if not isinstance(_image_list, list) else _image_list

            # Validate only one image is provided
            if len(image_list) > 1:
                raise derouter.BadRequestError(
                    message="DALL-E-2 only supports editing a single image. Please provide one image.",
                    model=model,
                    llm_provider="openai",
                )

            # Use "image" field name (singular) for DALL-E-2
            for _image in image_list:
                if _image is not None:
                    self._add_image_to_files(
                        files_list=files_list,
                        image=_image,
                        field_name="image",
                    )

        # Handle mask parameter if provided
        if _mask is not None:
            # Handle case where mask can be a list (extract first mask)
            if isinstance(_mask, list):
                _mask = _mask[0] if _mask else None

            if _mask is not None:
                mask_content_type: Final[str] = ImageEditRequestUtils.get_image_content_type(_mask)
                if isinstance(_mask, BufferedReader):
                    files_list.append(("mask", (_mask.name, _mask, mask_content_type)))
                else:
                    files_list.append(("mask", ("mask.png", _mask, mask_content_type)))

        return data_without_files, files_list
