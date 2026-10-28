import { NextResponse } from "next/server";
import { listPlans, createPlan, validatePlanInput } from "@/lib/db/repos/billingRepo.js";
import { getKeyGroups } from "@/lib/db/repos/keyGroupsRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** Admin plan list. `?active=1` narrows to purchasable plans. */
export async function GET(request) {
  try {
    const onlyActive = request.nextUrl.searchParams.get("active") === "1";
    const plans = await listPlans({ onlyActive });
    // Groups are returned alongside so the admin form can render the
    // "restricted to" picker without a second request.
    let groups = [];
    try {
      groups = await getKeyGroups();
    } catch {
      // No groups table yet — the picker just has nothing to offer.
    }
    return NextResponse.json({ plans, groups }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Failed to load plans" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  // Same rules the admin form applies, so a hand-rolled request cannot create a
  // plan the UI would reject (and vice versa).
  const invalid = validatePlanInput(body);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400, headers: NO_STORE });

  try {
    const plan = await createPlan(body);
    return NextResponse.json({ plan }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const message = error?.message || "Failed to create plan";
    const status = /already exists/i.test(message) ? 409 : 400;
    return NextResponse.json({ error: message }, { status, headers: NO_STORE });
  }
}
