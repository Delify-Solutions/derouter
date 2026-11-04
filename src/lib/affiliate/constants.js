// Shared literals of the affiliate program: the referral cookie and the click
// limiter, used by /r/<CODE> (writes it) and by registration (reads and clears it).

/** Where the referral link stores the code. Holds the normalised uppercase code. */
export const REF_COOKIE = "dr_ref";

/** Click counting: per IP, per hour. Over the limit the redirect still happens. */
export const CLICK_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 };
