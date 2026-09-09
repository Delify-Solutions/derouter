export interface GuardrailLitellmParams {
  guardrail?: string | null;
  api_base?: string | null;
  default_on?: boolean | null;
}

export interface GuardrailListItem {
  guardrail_id: string;
  guardrail_name: string | null;
  derouter_params?: GuardrailLitellmParams | null;
}

export interface GuardrailListResponse {
  guardrails?: GuardrailListItem[];
}

export const COMPRESSION_GUARDRAIL_PROVIDER = "headroom";

export const isCompressionGuardrail = (guardrail: GuardrailListItem): boolean =>
  (guardrail.derouter_params?.guardrail ?? "").toLowerCase() === COMPRESSION_GUARDRAIL_PROVIDER;

export const compressionGuardrailsOf = (response: GuardrailListResponse): GuardrailListItem[] =>
  (response.guardrails ?? []).filter(isCompressionGuardrail);

export interface CompressionGuardrailInput {
  name: string;
  apiBase: string;
  defaultOn: boolean;
}

export const buildCompressionGuardrailPayload = (input: CompressionGuardrailInput): Record<string, unknown> => ({
  guardrail_name: input.name.trim(),
  derouter_params: {
    guardrail: COMPRESSION_GUARDRAIL_PROVIDER,
    mode: "pre_call",
    api_base: input.apiBase.trim(),
    default_on: input.defaultOn,
  },
});
