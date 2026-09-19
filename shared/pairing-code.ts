export const pairingCodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ";
export const pairingCodeLength = 9;

// Nine letters provide 40.7 bits, exceeding the previous eight-character space.
// Existing eight-character invitations retain their original server-side expiry.
export const pairingCodePattern = /^(?:[ABCDEFGHJKMNPQRSTUVWXYZ]{9}|[A-Z2-9]{8})$/;
export const pairingRoomIdPattern = /^(?:[ABCDEFGHJKMNPQRSTUVWXYZ]{9}|[A-Z2-9]{8}|[A-Za-z0-9_-]{20,128})$/;
export const pairingCodeInputError = "Enter nine letters, without I, L or O. Do not use numbers, spaces or punctuation.";

export function normalisePairingCode(value: string): string | null {
  // Only fold ASCII letters so Unicode characters cannot become valid codes.
  const code = value.trim().replace(/[a-z]/g, character => character.toUpperCase());
  return pairingCodePattern.test(code) ? code : null;
}

export function createPairingCode(): string {
  const bytes = new Uint8Array(pairingCodeLength);
  const limit = 256 - (256 % pairingCodeAlphabet.length);
  let code = "";
  while (code.length < pairingCodeLength) {
    crypto.getRandomValues(bytes);
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      if (byte >= limit) continue;
      code += pairingCodeAlphabet[byte % pairingCodeAlphabet.length];
      if (code.length === pairingCodeLength) break;
    }
  }
  return code;
}
