export function getRoomStub(env) {
  const id = env.APS_ROOM.idFromName('aps-production-room');
  return env.APS_ROOM.get(id);
}
