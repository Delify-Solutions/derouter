import { NextResponse } from "next/server";
import { getKeyGroups, createKeyGroup } from "@/lib/localDb";

export async function GET() {
  try {
    const groups = await getKeyGroups();
    return NextResponse.json({ groups });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });
    const group = await createKeyGroup({
      name: body.name,
      isActive: body.isActive !== false,
      rpm: body.rpm ?? null,
      tpm: body.tpm ?? null,
      budgetUsd: body.budgetUsd ?? null,
      resetWindow: body.resetWindow ?? null,
      allowedModels: body.allowedModels ?? null,
      priceOverrides: body.priceOverrides ?? null,
    });
    return NextResponse.json({ group }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
