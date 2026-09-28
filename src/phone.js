import { config } from '#shared';

// Phone numbers arrive in many shapes: "0712 345 678", "+254712345678", "254712345678",
// "00254712345678". Users are stored with whatever format they signed up with (older
// accounts use the local "07..." form), so lookups match on every equivalent spelling.

function toE164(raw, countryCode = config.defaultCountryCode) {
  let s = String(raw ?? '').replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+')) return /^\+\d{7,15}$/.test(s) ? s : null;
  if (!/^\d{6,15}$/.test(s)) return null;
  if (s.startsWith('0')) return `+${countryCode}${s.slice(1)}`;
  if (s.startsWith(countryCode) && s.length > countryCode.length + 6) return `+${s}`;
  return `+${countryCode}${s}`;
}

/** Canonical form used when storing new accounts. */
export function normalizePhone(raw) {
  return toE164(raw);
}

/** Every stored spelling that denotes the same number (for queries). */
export function phoneVariants(raw) {
  const e164 = toE164(raw);
  if (!e164) return [];
  const variants = new Set([e164, e164.slice(1)]);
  const localPrefix = `+${config.defaultCountryCode}`;
  if (e164.startsWith(localPrefix)) variants.add(`0${e164.slice(localPrefix.length)}`);
  return [...variants];
}
