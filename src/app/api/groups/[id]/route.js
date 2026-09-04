import { NextResponse } from "next/server";
import { getKeyGroupById, updateKeyGroup, deleteKeyGroup } from "@/lib/localDb";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const group = await getKeyGroupById(id);
    if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });
    return NextResponse.json({ group });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const group = await updateKeyGroup(id, body);
    if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });
    return NextResponse.json({ group });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const ok = await deleteKeyGroup(id);
    if (!ok) return NextResponse.json({ error: "Group not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
