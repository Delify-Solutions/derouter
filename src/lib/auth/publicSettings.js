// What `/api/settings/require-login` (public, no session) may tell anyone.
//
// Only the two flags. The tunnel and Tailscale URLs are host names that reach
// the server around the CDN; an anonymous caller never gets them (spec
// model-privacy "Unauthenticated settings reveal no host"). The admin reads
// them through the authenticated settings API. Relative-import safe.

/** @returns {{ requireLogin: boolean, tunnelDashboardAccess: boolean }} */
export function publicLoginSettings(settings) {
  return {
    requireLogin: settings?.requireLogin !== false,
    tunnelDashboardAccess: settings?.tunnelDashboardAccess !== false,
  };
}
