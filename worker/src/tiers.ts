// Permission tiers, lowest to highest — matches PERMISSION_TIERS in
// index.html. Used both to validate incoming role values in
// handleUsersAdd/handleUsersUpdate, and (via tierAtLeast()) to enforce
// content-write permissions in ApsRoom.webSocketMessage(). Deliberately
// a plain string array, not a literal-tuple type — callers check it
// against untrusted request-body fields (JSON.parse's own `any`-typed
// output), so a stricter literal-union type would just fight the
// boundary this exists to validate, not add real safety.
export const VALID_TIERS: readonly string[] = ["viewer", "commenter", "editor", "projectAdmin", "admin"];

export function tierAtLeast(role: string | undefined, minTier: string): boolean {
  const mine = VALID_TIERS.indexOf(role || '');
  const need = VALID_TIERS.indexOf(minTier);
  return mine !== -1 && need !== -1 && mine >= need;
}
