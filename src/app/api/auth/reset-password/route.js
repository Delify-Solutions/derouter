import { NextResponse } from "next/server";
import { updateSettings } from "@/lib/localDb";
import { SESSIONS_VALID_AFTER_KEY, revokeAllDashboardSessionsValue } from "@/lib/auth/dashboardSession";

// Reset dashboard password to default by clearing the stored hash.
// Local-only (enforced by dashboardGuard). Never returns the default literal.
export async function POST() {
  try {
    // Resetting the password also signs out every dashboard session.
    await updateSettings({ password: null, [SESSIONS_VALID_AFTER_KEY]: revokeAllDashboardSessionsValue() });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
