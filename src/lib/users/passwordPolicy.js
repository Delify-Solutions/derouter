// The one password policy, in one importable place (spec account-registration
// "One password policy").
//
// Split out of register.js on purpose: register.js pulls in settings, the mailer and
// the user repo (all `@/`-aliased), so `node --test` cannot import it. The rule and
// its message are pure, and every path that sets a password — public signup, reset by
// token, the signed-in change form, admin create and admin reset — must state the
// SAME rule, so it lives here with no dependencies.
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

/**
 * A Vietnamese message naming the rule, or null when the password is acceptable.
 * Vietnamese because every caller surfaces this string verbatim on a
 * Vietnamese-language surface.
 */
export function validatePassword(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    return `Mật khẩu phải có từ ${PASSWORD_MIN_LENGTH} đến ${PASSWORD_MAX_LENGTH} ký tự`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Mật khẩu phải có từ ${PASSWORD_MIN_LENGTH} đến ${PASSWORD_MAX_LENGTH} ký tự`;
  }
  return null;
}
