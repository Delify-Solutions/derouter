import { toast } from "@/lib/toast";
import { Model, modelCreateCall } from "../networking";
import { provider_map } from "../provider_info_helpers";
import { ptuPickerToUtcIso } from "../../utils/ptuDatetime";

export const prepareModelAddRequest = async (formValues: Record<string, any>, accessToken: string, form: any) => {
  try {
    // Get model mappings and safely remove from formValues
    const modelMappings = formValues["model_mappings"] || [];
    if ("model_mappings" in formValues) {
      delete formValues["model_mappings"];
    }

    // Handle wildcard case
    if (formValues["model"] && formValues["model"].includes("all-wildcard")) {
      const customProviderKey = formValues["custom_llm_provider"] as string;
      const mappedProvider =
        provider_map[customProviderKey as keyof typeof provider_map] ?? customProviderKey.toLowerCase();
      const derouter_custom_provider = mappedProvider;
      const wildcardModel = derouter_custom_provider + "/*";
      formValues["model_name"] = wildcardModel;
      modelMappings.push({
        public_name: wildcardModel,
        derouter_model: wildcardModel,
      });
      formValues["model"] = wildcardModel;
    }

    // Create a deployment for each mapping
    const deployments = [];
    for (const mapping of modelMappings) {
      const derouterParamsObj: Record<string, any> = {};
      const modelInfoObj: Record<string, any> = {};

      // Set the model name and derouter model from the mapping
      const modelName = mapping.public_name;
      derouterParamsObj["model"] = mapping.derouter_model;

      // Handle pricing conversion before processing other fields
      // Use explicit checks to allow 0 (zero cost models for budget bypass)
      if (
        formValues.input_cost_per_token !== undefined &&
        formValues.input_cost_per_token !== null &&
        formValues.input_cost_per_token !== ""
      ) {
        formValues.input_cost_per_token = Number(formValues.input_cost_per_token) / 1000000;
      }
      if (
        formValues.output_cost_per_token !== undefined &&
        formValues.output_cost_per_token !== null &&
        formValues.output_cost_per_token !== ""
      ) {
        formValues.output_cost_per_token = Number(formValues.output_cost_per_token) / 1000000;
      }

      // Cache Read Cost: if blank, default to Input Cost (already token-unit converted above)
      if (
        formValues.cache_read_input_token_cost !== undefined &&
        formValues.cache_read_input_token_cost !== null &&
        formValues.cache_read_input_token_cost !== ""
      ) {
        formValues.cache_read_input_token_cost = Number(formValues.cache_read_input_token_cost) / 1000000;
      } else if (
        formValues.input_cost_per_token !== undefined &&
        formValues.input_cost_per_token !== null &&
        formValues.input_cost_per_token !== ""
      ) {
        formValues.cache_read_input_token_cost = Number(formValues.input_cost_per_token);
      } else {
        delete formValues.cache_read_input_token_cost;
      }

      // Cache Write Cost: explicit value if provided, else leave unset so the
      // backend keeps the model-level default (per-second pricing, model_prices
      // entries, etc.). Sending 0 here would overwrite that default.
      // The backend falls back to input_cost_per_token when this key is absent.
      if (
        formValues.cache_creation_input_token_cost !== undefined &&
        formValues.cache_creation_input_token_cost !== null &&
        formValues.cache_creation_input_token_cost !== ""
      ) {
        formValues.cache_creation_input_token_cost = Number(formValues.cache_creation_input_token_cost) / 1000000;
      } else {
        delete formValues.cache_creation_input_token_cost;
      }
      // Keep input_cost_per_second as is, no conversion needed

      // Iterate through the key-value pairs in formValues
      derouterParamsObj["model"] = mapping.derouter_model;
      for (const [key, value] of Object.entries(formValues)) {
        if (value === "") {
          continue;
        }
        if (key === "derouter_credential_name" && value == null) {
          continue;
        }
        // Skip the custom_pricing and pricing_model fields as they're only used for UI control
        if (key === "custom_pricing" || key === "pricing_model" || key === "cache_control") {
          continue;
        }
        if (key == "model_name") {
          derouterParamsObj["model"] = value;
        } else if (key == "custom_llm_provider") {
          const providerKey = value as string;
          const mappingResult = provider_map[providerKey as keyof typeof provider_map] ?? providerKey.toLowerCase();
          derouterParamsObj["custom_llm_provider"] = mappingResult;
        } else if (key == "model") {
          continue;
        }
        // Check if key is "base_model"
        else if (key === "base_model") {
          // Add key-value pair to model_info dictionary
          modelInfoObj[key] = value;
        } else if (key === "team_id") {
          modelInfoObj["team_id"] = value;
        } else if (key === "model_access_group") {
          modelInfoObj["access_groups"] = value;
        } else if (key == "mode") {
          modelInfoObj["mode"] = value;

          // remove "mode" from derouterParams
          delete derouterParamsObj["mode"];
        } else if (key === "custom_model_name") {
          derouterParamsObj["model"] = value;
        } else if (key == "derouter_extra_params") {
          let derouterExtraParams = {};
          if (value && value != undefined) {
            try {
              derouterExtraParams = JSON.parse(value);
            } catch (error) {
              toast.fromError("Failed to parse DeRouter Extra Params: " + error);
              throw new Error("Failed to parse derouter_extra_params: " + error);
            }
            if ("derouter_credential_name" in derouterExtraParams && formValues.derouter_credential_name) {
              delete derouterExtraParams.derouter_credential_name;
            }
            for (const [key, value] of Object.entries(derouterExtraParams)) {
              derouterParamsObj[key] = value;
            }
          }
        } else if (key == "model_info_params") {
          let modelInfoParams = {};
          if (value && value != undefined) {
            try {
              modelInfoParams = JSON.parse(value);
            } catch (error) {
              toast.fromError("Failed to parse DeRouter Extra Params: " + error);
              throw new Error("Failed to parse derouter_extra_params: " + error);
            }
            for (const [key, value] of Object.entries(modelInfoParams)) {
              modelInfoObj[key] = value;
            }
          }
        }

        // Handle the pricing fields
        else if (
          key === "input_cost_per_token" ||
          key === "output_cost_per_token" ||
          key === "input_cost_per_second" ||
          key === "cache_read_input_token_cost" ||
          key === "cache_creation_input_token_cost"
        ) {
          if (value !== undefined && value !== null && value !== "") {
            derouterParamsObj[key] = Number(value);
          }
          continue;
        }

        // Handle the PTU flat-cost fields (attributed to the team via model_info)
        else if (key === "ptu_count" || key === "cost_per_ptu_per_hour") {
          if (value !== undefined && value !== null && value !== "") {
            modelInfoObj[key] = Number(value);
          }
          continue;
        }

        // Handle the PTU effective window (DatePicker dayjs value -> ISO 8601 UTC string)
        else if (key === "ptu_effective_from" || key === "ptu_effective_to") {
          const iso = ptuPickerToUtcIso(value);
          if (iso !== null) {
            modelInfoObj[key] = iso;
          }
          continue;
        }

        // Check if key is any of the specified API related keys
        else {
          // Add key-value pair to derouter_params dictionary
          derouterParamsObj[key] = value;
        }
      }

      deployments.push({ derouterParamsObj, modelInfoObj, modelName });
    }

    return deployments;
  } catch (error) {
    toast.fromError("Failed to create model: " + error);
  }
};

export const handleAddModelSubmit = async (values: any, accessToken: string, form: any, callback?: () => void) => {
  try {
    const deployments = await prepareModelAddRequest(values, accessToken, form);

    if (!deployments || deployments.length === 0) {
      return; // Exit if preparation failed or no deployments
    }

    // Create each deployment
    for (const deployment of deployments) {
      const { derouterParamsObj, modelInfoObj, modelName } = deployment;

      const new_model: Model = {
        model_name: modelName,
        derouter_params: derouterParamsObj,
        model_info: modelInfoObj,
      };

      await modelCreateCall(accessToken, new_model);
    }

    callback && callback();
    form.resetFields();
  } catch (error) {
    toast.fromError("Failed to add model: " + error);
  }
};
