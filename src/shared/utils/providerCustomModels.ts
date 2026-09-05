export interface CustomModelEntry {
  id: string;
  kind?: string;
  type?: string;
  name?: string | null;
  providerAlias?: string;
  [key: string]: unknown;
}

interface BuiltInModel {
  id: string;
  [key: string]: unknown;
}

interface ModelAliasMap {
  [alias: string]: string;
}

interface ProviderCustomModelRow {
  id: string;
  name: string;
  fullModel: string;
  source: "custom" | "legacyAlias";
  type: string;
  alias?: string;
}

interface GetProviderCustomModelRowsOpts {
  customModels?: CustomModelEntry[];
  modelAliases?: ModelAliasMap;
  providerAlias: string;
  builtInModels?: BuiltInModel[];
  type?: string;
  includeLegacyAliases?: boolean;
}

function modelType(model: CustomModelEntry): string {
  return model?.kind || model?.type || "llm";
}

export function getProviderCustomModelRows({
  customModels = [],
  modelAliases = {},
  providerAlias,
  builtInModels = [],
  type = "llm",
  includeLegacyAliases = true,
}: GetProviderCustomModelRowsOpts): ProviderCustomModelRow[] {
  const builtInIds = new Set(builtInModels.map((model) => model.id));
  const seenFullModels = new Set<string>();
  const rows: ProviderCustomModelRow[] = [];

  for (const model of customModels) {
    if (!model?.id || model.providerAlias !== providerAlias) continue;
    const rowType = modelType(model);
    if (type && rowType !== type) continue;
    if (builtInIds.has(model.id)) continue;

    const fullModel = `${providerAlias}/${model.id}`;
    if (seenFullModels.has(fullModel)) continue;
    seenFullModels.add(fullModel);
    rows.push({
      id: model.id,
      name: model.name || model.id,
      fullModel,
      source: "custom",
      type: rowType,
    });
  }

  if (!includeLegacyAliases) return rows;

  const prefix = `${providerAlias}/`;
  for (const [alias, fullModel] of Object.entries(modelAliases || {})) {
    if (typeof fullModel !== "string" || !fullModel.startsWith(prefix)) continue;
    const id = fullModel.slice(prefix.length);
    if (!id || builtInIds.has(id) || seenFullModels.has(fullModel)) continue;

    seenFullModels.add(fullModel);
    rows.push({
      id,
      name: alias,
      alias,
      fullModel,
      source: "legacyAlias",
      type: type || "llm",
    });
  }

  return rows;
}
