from typing import Final

import derouter
from derouter import CustomLLM
from derouter.types.utils import ModelResponse


class MyCustomLLM(CustomLLM):
    def completion(self, *args, **kwargs) -> ModelResponse:
        return derouter.completion(
            model="gpt-3.5-turbo",
            messages=[{"role": "user", "content": "Hello world"}],
            mock_response="Hi!",
        )

    async def acompletion(self, *args, **kwargs) -> derouter.ModelResponse:
        return derouter.completion(
            model="gpt-3.5-turbo",
            messages=[{"role": "user", "content": "Hello world"}],
            mock_response="Hi!",
        )


my_custom_llm: Final = MyCustomLLM()
