from typing import Final, Literal

import derouter
from derouter.exceptions import BadRequestError
from derouter.derouter_core_utils.get_llm_provider_logic import declared_authenticating_provider
from derouter.types.utils import LlmProviders, LlmProvidersSet


def get_supported_openai_params(
    model: str,
    custom_llm_provider: str | None = None,
    request_type: Literal["chat_completion", "embeddings", "transcription"] = "chat_completion",
    base_model: str | None = None,
) -> list | None:
    """
    Returns the supported openai params for a given model + provider

    Example:
    ```
    get_supported_openai_params(model="anthropic.claude-3", custom_llm_provider="bedrock")
    ```

    Args:
        base_model: An optional capability hint for deployments whose ``model``
            label isn't recognized on its own (e.g. an Azure deployment name, or a
            friendly Bedrock alias). It is additive: the result is the union of the
            params supported by ``model`` and by ``base_model``, so a hint can only
            add capabilities, never strip ones the real model already supports.

    Returns:
    - List if custom_llm_provider is mapped
    - None if unmapped
    """
    if not custom_llm_provider:
        custom_llm_provider = declared_authenticating_provider(
            model
        )  # rebind-ok: resolving would run the provider's OAuth flow
    if not custom_llm_provider:
        try:
            custom_llm_provider = derouter.get_llm_provider(model=model)[1]
        except BadRequestError:
            return None

    if custom_llm_provider in LlmProvidersSet:
        provider_config = derouter.ProviderConfigManager.get_provider_chat_config(
            model=model,
            provider=LlmProviders(custom_llm_provider),
            base_model=base_model,
        )
    elif custom_llm_provider.split("/")[0] in LlmProvidersSet:
        provider_config = derouter.ProviderConfigManager.get_provider_chat_config(
            model=model,
            provider=LlmProviders(custom_llm_provider.split("/")[0]),
            base_model=base_model,
        )
    else:
        provider_config = None

    if provider_config and request_type == "chat_completion":
        supported_params = provider_config.get_supported_openai_params(model=model)
        if base_model and base_model != model:
            base_model_params: Final = provider_config.get_supported_openai_params(model=base_model)
            supported_params = list(dict.fromkeys([*supported_params, *base_model_params]))
        return supported_params

    if custom_llm_provider == "bedrock" or custom_llm_provider == "bedrock_converse":
        return derouter.AmazonConverseConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "meta_llama":
        provider_config = derouter.ProviderConfigManager.get_provider_chat_config(
            model=model, provider=LlmProviders.LLAMA
        )
        if provider_config:
            return provider_config.get_supported_openai_params(model=model)
    elif custom_llm_provider == "ollama":
        return derouter.OllamaConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "ollama_chat":
        return derouter.OllamaChatConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "anthropic":
        return derouter.AnthropicConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "anthropic_text":
        return derouter.AnthropicTextConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "fireworks_ai":
        if request_type == "embeddings":
            return derouter.FireworksAIEmbeddingConfig().get_supported_openai_params(model=model)
        elif request_type == "transcription":
            return None
        else:
            return derouter.FireworksAIConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "nvidia_nim":
        if request_type == "chat_completion":
            return derouter.nvidiaNimConfig.get_supported_openai_params(model=model)
        elif request_type == "embeddings":
            return derouter.nvidiaNimEmbeddingConfig.get_supported_openai_params()
    elif custom_llm_provider == "cerebras":
        return derouter.CerebrasConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "baseten":
        return derouter.BasetenConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "xai":
        return derouter.XAIChatConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "ai21_chat" or custom_llm_provider == "ai21":
        return derouter.AI21ChatConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "volcengine":
        return derouter.VolcEngineConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "groq":
        return derouter.GroqChatConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "bedrock_mantle":
        return derouter.BedrockMantleChatConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "hosted_vllm":
        return derouter.HostedVLLMChatConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "vllm":
        return derouter.VLLMConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "deepseek":
        return derouter.DeepSeekChatConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "tencent":
        return derouter.TencentChatConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "cohere_chat" or custom_llm_provider == "cohere":
        return derouter.CohereChatConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "maritalk":
        return derouter.MaritalkConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "openai":
        if request_type == "transcription":
            transcription_provider_config = derouter.ProviderConfigManager.get_provider_audio_transcription_config(
                model=model, provider=LlmProviders.OPENAI
            )
            if isinstance(transcription_provider_config, derouter.OpenAIGPTAudioTranscriptionConfig):
                return transcription_provider_config.get_supported_openai_params(model=model)
            else:
                raise ValueError(f"Unsupported provider config: {transcription_provider_config} for model: {model}")
        return derouter.OpenAIConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "sap":
        if request_type == "chat_completion":
            return derouter.GenAIHubOrchestrationConfig().get_supported_openai_params(model=model)
        elif request_type == "embeddings":
            return derouter.GenAIHubEmbeddingConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "azure":
        _azure_detection_model: Final = base_model or model
        if derouter.AzureOpenAIO1Config().is_o_series_model(model=_azure_detection_model):
            return derouter.AzureOpenAIO1Config().get_supported_openai_params(model=_azure_detection_model)
        elif derouter.AzureOpenAIGPT5Config.is_model_gpt_5_model(model=_azure_detection_model):
            return derouter.AzureOpenAIGPT5Config().get_supported_openai_params(model=_azure_detection_model)
        else:
            return derouter.AzureOpenAIConfig().get_supported_openai_params(model=_azure_detection_model)
    elif custom_llm_provider == "openrouter":
        return derouter.OpenrouterConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "vercel_ai_gateway":
        return derouter.VercelAIGatewayConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "mistral" or custom_llm_provider == "codestral":
        # mistal and codestral api have the exact same params
        if request_type == "chat_completion":
            return derouter.MistralConfig().get_supported_openai_params(model=model)
        elif request_type == "embeddings":
            return derouter.MistralEmbeddingConfig().get_supported_openai_params()
        elif request_type == "transcription":
            from derouter.llms.mistral.audio_transcription.transformation import (
                MistralAudioTranscriptionConfig,
            )

            return MistralAudioTranscriptionConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "text-completion-codestral":
        return derouter.CodestralTextCompletionConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "sambanova":
        if request_type == "embeddings":
            return derouter.SambaNovaEmbeddingConfig().get_supported_openai_params(model=model)
        else:
            return derouter.SambanovaConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "nebius":
        if request_type == "chat_completion":
            return derouter.NebiusConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "wandb":
        if request_type == "chat_completion":
            return derouter.WandbConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "replicate":
        return derouter.ReplicateConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "huggingface":
        return derouter.HuggingFaceChatConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "jina_ai":
        if request_type == "embeddings":
            return derouter.JinaAIEmbeddingConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "together_ai":
        return derouter.TogetherAIChatConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "databricks":
        if request_type == "chat_completion":
            return derouter.DatabricksConfig().get_supported_openai_params(model=model)
        elif request_type == "embeddings":
            return derouter.DatabricksEmbeddingConfig().get_supported_openai_params()
    elif custom_llm_provider == "palm" or custom_llm_provider == "gemini":
        return derouter.GoogleAIStudioGeminiConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "novita":
        return derouter.NovitaConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "vertex_ai" or custom_llm_provider == "vertex_ai_beta":
        if request_type == "chat_completion":
            if model.startswith("mistral"):
                return derouter.MistralConfig().get_supported_openai_params(model=model)
            elif model.startswith("codestral"):
                return derouter.CodestralTextCompletionConfig().get_supported_openai_params(model=model)
            elif model.startswith("claude"):
                return derouter.VertexAIAnthropicConfig().get_supported_openai_params(model=model)
            elif model.startswith("gemini"):
                return derouter.VertexGeminiConfig().get_supported_openai_params(model=model)
            else:
                return derouter.VertexAILlama3Config().get_supported_openai_params(model=model)
        elif request_type == "embeddings":
            return derouter.VertexAITextEmbeddingConfig().get_supported_openai_params()
    elif custom_llm_provider == "sagemaker":
        return derouter.SagemakerConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "aleph_alpha":
        return [
            "max_tokens",
            "stream",
            "top_p",
            "temperature",
            "presence_penalty",
            "frequency_penalty",
            "n",
            "stop",
        ]
    elif custom_llm_provider == "cloudflare":
        return derouter.CloudflareChatConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "nlp_cloud":
        return derouter.NLPCloudConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "petals":
        return derouter.PetalsConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "deepinfra":
        return derouter.DeepInfraConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "perplexity":
        return derouter.PerplexityChatConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "nscale":
        return derouter.NscaleConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "anyscale":
        return [
            "temperature",
            "top_p",
            "stream",
            "max_tokens",
            "stop",
            "frequency_penalty",
            "presence_penalty",
        ]
    elif custom_llm_provider == "watsonx":
        return derouter.IBMWatsonXChatConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "watsonx_text":
        return derouter.IBMWatsonXAIConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "custom_openai" or custom_llm_provider == "text-completion-openai":
        return derouter.OpenAITextCompletionConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "predibase":
        return derouter.PredibaseConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "voyage":
        if request_type == "embeddings" and derouter.VoyageMultimodalEmbeddingConfig.is_multimodal_embeddings(model):
            return derouter.VoyageMultimodalEmbeddingConfig().get_supported_openai_params(model=model)
        return derouter.VoyageEmbeddingConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "infinity":
        return derouter.InfinityEmbeddingConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "triton":
        if request_type == "embeddings":
            return derouter.TritonEmbeddingConfig().get_supported_openai_params(model=model)
        else:
            return derouter.TritonConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "deepgram":
        if request_type == "transcription":
            return derouter.DeepgramAudioTranscriptionConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "ovhcloud":
        if request_type == "transcription":
            from derouter.llms.ovhcloud.audio_transcription.transformation import (
                OVHCloudAudioTranscriptionConfig,
            )

            return OVHCloudAudioTranscriptionConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "scaleway":
        if request_type == "transcription":
            from derouter.llms.scaleway.audio_transcription.transformation import (
                ScalewayAudioTranscriptionConfig,
            )

            return ScalewayAudioTranscriptionConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "elevenlabs":
        if request_type == "transcription":
            from derouter.llms.elevenlabs.audio_transcription.transformation import (
                ElevenLabsAudioTranscriptionConfig,
            )

            return ElevenLabsAudioTranscriptionConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider == "soniox":
        if request_type == "transcription":
            return derouter.SonioxAudioTranscriptionConfig().get_supported_openai_params(model=model)
    elif custom_llm_provider in derouter._custom_providers:
        if request_type == "chat_completion":
            provider_config = derouter.ProviderConfigManager.get_provider_chat_config(
                model=model, provider=LlmProviders.CUSTOM
            )
            if provider_config:
                return provider_config.get_supported_openai_params(model=model)
        elif request_type == "embeddings" or request_type == "transcription":
            return None

    return None
