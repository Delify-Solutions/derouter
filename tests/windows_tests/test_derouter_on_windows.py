import asyncio
import subprocess
import time
import traceback
import platform

import pytest



def test_using_derouter_on_windows():
    """Test that DeRouter can be imported on Windows systems."""

    try:
        import derouter

        print(
            f"derouter imported successfully on Windows ({platform.system()} {platform.release()})"
        )

        response = derouter.completion(
            model="gpt-4o",
            messages=[
                {
                    "role": "user",
                    "content": "This should never fail. Email ishaan@berri.ai if this test ever fails.",
                }
            ],
            mock_response="Hello, how are you?",
        )
        print(response)
    except Exception as e:
        pytest.fail(
            f"Error occurred on Windows: {e}. Installing derouter on Windows failed."
        )
