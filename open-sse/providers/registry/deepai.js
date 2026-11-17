const deepaiProvider = {
  id: "deepai",
  priority: 96,
  alias: "deepai",
  uiAlias: "deepai",
  display: {
    name: "DeepAI Code",
    icon: "bolt",
    color: "#0F6FFF",
    textIcon: "DA",
    website: "https://deepai.org",
    notice: {
      signupUrl: "https://deepai.org",
    },
  },
  category: "freeTier",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://api.deepai.org/deepai_code/chat/completions",
    format: "openai",
    auth: {
      combined: true,
      header: "api-key",
      scheme: "raw",
    },
  },
  models: [
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepai-cyber", name: "DeepAI Cyber" },
    { id: "muse-ember", name: "Muse Ember" },
  ],
  serviceKinds: ["llm"],
  oauth: {
    signInUrl: "https://api.deepai.org/deepai_code/desktop_auth/",
    exchangeUrl: "https://api.deepai.org/deepai_code/desktop_auth/exchange/",
    modelsUrl: "https://api.deepai.org/deepai_code/models",
    callbackPath: "/auth-callback",
  },
  passthroughModels: true,
};
export default deepaiProvider;
