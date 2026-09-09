import type { SearchToolInfo, SearchToolDeRouterParams } from "./types";

export interface SearchToolFormValues {
  search_tool_name: string;
  search_provider: string;
  api_key?: string | null;
  description?: string | null;
}

export interface SearchToolPayload {
  search_tool_name: string;
  derouter_params: SearchToolDeRouterParams;
  search_tool_info: SearchToolInfo | undefined;
}

export const buildSearchToolPayload = (values: SearchToolFormValues): SearchToolPayload => ({
  search_tool_name: values.search_tool_name,
  derouter_params: {
    search_provider: values.search_provider,
    api_key: values.api_key,
  },
  search_tool_info: values.description ? { description: values.description } : undefined,
});
