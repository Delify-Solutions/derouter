import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";

// Design D15: this surface is for ADMIN keys only. A customer key (row with a
// userId) is reported as not found rather than forbidden — the id space is not a
// directory, and an admin should not be able to edit or delete a customer's key
// from the endpoint page at all.
function notFound() {
  return NextResponse.json({ error: "Key not found" }, { status: 404 });
}

async function loadAdminKey(id) {
  const key = await getApiKeyById(id);
  if (!key || key.userId != null) return null;
  return key;
}

// GET /api/keys/[id] - Get single admin key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await loadAdminKey(id);
    if (!key) return notFound();
    return NextResponse.json({ key });
  } catch {
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update an admin key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();

    const existing = await loadAdminKey(id);
    if (!existing) return notFound();

    // Allow toggling active state + advanced limit fields.
    const updateData = {};
    if (body.isActive !== undefined) updateData.isActive = body.isActive;
    if (body.name !== undefined) updateData.name = body.name;
    if (body.rpm !== undefined) updateData.rpm = body.rpm;
    if (body.tpm !== undefined) updateData.tpm = body.tpm;
    if (body.budgetUsd !== undefined) updateData.budgetUsd = body.budgetUsd;
    if (body.resetWindow !== undefined) updateData.resetWindow = body.resetWindow;
    if (body.expiresAt !== undefined) updateData.expiresAt = body.expiresAt;
    if (body.allowedModels !== undefined) updateData.allowedModels = body.allowedModels;

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to update key" }, { status: 400 });
  }
}

// DELETE /api/keys/[id] - Delete an admin key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const existing = await loadAdminKey(id);
    if (!existing) return notFound();

    const deleted = await deleteApiKey(id);
    if (!deleted) return notFound();

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch {
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
