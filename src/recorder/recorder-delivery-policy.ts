export const SOLO_PEER_WINDOW_SIZE = 64;
export const SOLO_PEER_WINDOW_MAX_BYTES = 64 * 1024 * 1024;

export function canAcceptSoloPeerBlock(
  deliveredBlockCount: number,
  deliveredBytes: number,
  nextBlockBytes: number,
) {
  if (deliveredBlockCount >= SOLO_PEER_WINDOW_SIZE) return false;
  return deliveredBlockCount === 0
    || deliveredBytes + nextBlockBytes <= SOLO_PEER_WINDOW_MAX_BYTES;
}
