import { NextResponse } from "next/server";
import { getCombos, getCustomModels } from "@/lib/localDb";
import { getProviderNodes } from "@/lib/db/repos/nodesRepo.js";
import { detectModelKind } from "@/lib/models/modelKind.js";
import { pingModelByKind } from "./ping";

// POST /api/models/test - Ping a single model via the endpoint that matches its kind.
// `kind` may be omitted or "auto": the kind is then taken from what is recorded for the
// model (custom model type, combo kind, image-only node) and finally from its name, so
// one test button works for text and image models alike. The result names the kind used.
export async function POST(request) {
  try {
    const { model, kind } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });

    let resolved = kind;
    if (!resolved || resolved === "auto") {
      const [customModels, nodes, combos] = await Promise.all([
        getCustomModels().catch(() => []),
        getProviderNodes().catch(() => []),
        getCombos().catch(() => []),
      ]);
      resolved = detectModelKind(model, { customModels, nodes, combos });
    }

    const result = await pingModelByKind(model, resolved);
    return NextResponse.json({ ...result, kind: resolved });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
