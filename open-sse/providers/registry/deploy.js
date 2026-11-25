// Deploy (deploy.com, formerly Hive) — OpenAI-compatible inference plus its own
// proprietary moderation/detection models. Two credentials per account, deliberately:
//   - the Secret Key (apiKey) authenticates inference on api.deploy.com;
//   - the portal session cookie (providerSpecificData.cookie) is the ONLY thing the
//     prepaid-balance endpoint accepts. It lives in the portal, not the API, so the
//     balance row on /dashboard/quota needs it; without it the usage handler says so
//     instead of inventing a number.
// Auth header is a plain Bearer; the wire body is OpenAI Chat Completions.
const deployProvider = {
  id: "deploy",
  priority: 55,
  alias: "deploy",
  aliases: ["dp"],
  uiAlias: "deploy",
  display: {
    name: "Deploy",
    icon: "deployed_code",
    color: "#5B5BD6",
    textIcon: "DP",
    website: "https://deploy.com",
    notice: {
      // Key page + the two facts an operator needs before wiring it up.
      apiKeyUrl: "https://portal.deploy.com/?api_keys=1",
      text:
        "Create the Secret Key under Service API Keys (shown once). The prepaid balance "
        + "is read from the portal session cookie, not from the key: paste "
        + "hive-portal-production=… from portal.deploy.com DevTools to see it on /dashboard/quota.",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  serviceKinds: ["llm"],
  transport: {
    baseUrl: "https://api.deploy.com/api/v1/chat/completions",
    // /api/v1/models is public (no key), so it cannot tell a good key from a bad one.
    // The usage endpoint (portal balance) is keyed by cookie, which is why the quota
    // page, not the add-key form, is where a key problem surfaces: an unauthorized
    // chat probe is what confirms the Secret Key.
    validateUrl: "https://api.deploy.com/api/v1/models",
    usage: {
      // Portal profile: resolves the organization id the balance path needs.
      url: "https://ajax-portal.deploy.com/api/profile",
      // https://ajax-portal.deploy.com/api/organization/{organizationId}/balance
      organizationUrl: "https://ajax-portal.deploy.com/api/organization",
    },
    retry: { "429": 2, "503": 2 },
  },
  // Curated seed; the live catalogue is small and already discoverable through the
  // public /api/v1/models, so anything else is accepted as a passthrough id.
  models: [
    { id: "deepseek-ai/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017" },
    { id: "zai-org/glm-5.3-flash", name: "Z.AI GLM-5.3 Flash" },
  ],
  modelsFetcher: { url: "https://api.deploy.com/api/v1/models", type: "openai" },
  passthroughModels: true,
  features: {
    usage: true,
    usageApikey: true,
  },
};
export default deployProvider;
