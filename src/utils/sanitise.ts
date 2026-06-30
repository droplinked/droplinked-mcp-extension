/**
 * Generic response shaping helper.
 *
 * The tools in this server project the public API's responses onto a
 * small, explicit set of consumer-facing fields. This helper performs a
 * shallow copy of a record so a projection always works against a plain
 * object, regardless of the exact envelope shape the API returns.
 */
export function shapeRecord<T extends Record<string, unknown>>(
  record: T,
): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(record)) {
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
