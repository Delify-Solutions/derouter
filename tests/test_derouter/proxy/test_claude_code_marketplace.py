import pytest


@pytest.mark.asyncio
async def test_claude_code_plugin_table_schema_exists():

    with open("schema.prisma", "r") as f:
        schema = f.read()
    assert "DeRouter_ClaudeCodePluginTable" in schema, (
        "DeRouter_ClaudeCodePluginTable model missing from schema.prisma - "
        "this causes AttributeError on all /claude-code/plugins endpoints"
    )

    with open("derouter/proxy/schema.prisma", "r") as f:
        proxy_schema = f.read()
    assert (
        "DeRouter_ClaudeCodePluginTable" in proxy_schema
    ), "DeRouter_ClaudeCodePluginTable model missing from derouter/proxy/schema.prisma"
