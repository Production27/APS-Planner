// Permission tiers, lowest to highest — matches PERMISSION_TIERS in
// index.html. Used both to validate incoming role values in
// handleUsersAdd/handleUsersUpdate, and (via tierAtLeast()) to enforce
// content-write permissions in ApsRoom.webSocketMessage().
export const VALID_TIERS = ["viewer", "commenter", "editor", "projectAdmin", "admin"];
export function tierAtLeast(role, minTier) {
  const mine = VALID_TIERS.indexOf(role);
  const need = VALID_TIERS.indexOf(minTier);
  return mine !== -1 && need !== -1 && mine >= need;
}
