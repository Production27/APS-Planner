export function getRoomStub(env: Env): DurableObjectStub {
  const id = env.APS_ROOM.idFromName('aps-production-room');
  return env.APS_ROOM.get(id);
}
