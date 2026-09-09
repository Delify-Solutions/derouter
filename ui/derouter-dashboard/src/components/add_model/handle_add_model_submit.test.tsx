import { describe, expect, it, vi } from "vitest";
import { prepareModelAddRequest } from "./handle_add_model_submit";

vi.mock("../networking", () => ({
  modelCreateCall: vi.fn(),
}));

describe("prepareModelAddRequest", () => {
  it("returns deployment data for the most basic form", async () => {
    const formValues = {
      model_mappings: [
        {
          public_name: "Public Model",
          derouter_model: "derouter/public",
        },
      ],
      model_name: "custom-model-name",
      base_model: "gpt-4",
      team_id: "team-123",
      model_access_group: ["group-1"],
      input_cost_per_token: "2000000",
      output_cost_per_token: "1000000",
    };

    const deployments = await prepareModelAddRequest({ ...formValues }, "token", null);

    expect(deployments).toHaveLength(1);
    const [deployment] = deployments!;
    expect(deployment.modelName).toBe("Public Model");
    expect(deployment.derouterParamsObj.model).toBe("custom-model-name");
    expect(deployment.derouterParamsObj.input_cost_per_token).toBe(2);
    expect(deployment.derouterParamsObj.output_cost_per_token).toBe(1);
    expect(deployment.modelInfoObj.base_model).toBe("gpt-4");
    expect(deployment.modelInfoObj.access_groups).toEqual(["group-1"]);
    expect(deployment.modelInfoObj.team_id).toBe("team-123");
  });

  it("uses a lowercase fallback for unrecognized custom providers", async () => {
    const fallbackValues = {
      model_mappings: [
        {
          public_name: "Petals Model",
          derouter_model: "petals/model",
        },
      ],
      model_name: "petals/model",
      custom_llm_provider: "Petals",
    };

    const deployments = await prepareModelAddRequest({ ...fallbackValues }, "token", null);

    expect(deployments).toHaveLength(1);
    const [deployment] = deployments!;
    expect(deployment.derouterParamsObj.custom_llm_provider).toBe("petals");
  });

  it("ignores derouter_credential_name inside DeRouter Params JSON", async () => {
    const formValues = {
      model_mappings: [
        {
          public_name: "Public Model",
          derouter_model: "derouter/public",
        },
      ],
      model_name: "custom-model-name",
      derouter_credential_name: "selected-credential",
      derouter_extra_params: JSON.stringify({
        derouter_credential_name: "from-json",
        timeout: 5,
      }),
    };

    const deployments = await prepareModelAddRequest({ ...formValues }, "token", null);

    expect(deployments).toHaveLength(1);
    const [deployment] = deployments!;
    expect(deployment.derouterParamsObj.derouter_credential_name).toBe("selected-credential");
    expect(deployment.derouterParamsObj.timeout).toBe(5);
  });

  it("keeps derouter_credential_name from DeRouter Params JSON when no credential is selected", async () => {
    const formValues = {
      model_mappings: [
        {
          public_name: "Public Model",
          derouter_model: "derouter/public",
        },
      ],
      model_name: "custom-model-name",
      derouter_extra_params: JSON.stringify({
        derouter_credential_name: "from-json",
        timeout: 5,
      }),
      derouter_credential_name: null,
    };

    const deployments = await prepareModelAddRequest({ ...formValues }, "token", null);

    expect(deployments).toHaveLength(1);
    const [deployment] = deployments!;
    expect(deployment.derouterParamsObj.derouter_credential_name).toBe("from-json");
    expect(deployment.derouterParamsObj.timeout).toBe(5);
  });
});
