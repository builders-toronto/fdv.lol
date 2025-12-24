const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = (() => {
  const map = new Map();
  for (let i = 0; i < ALPHABET.length; i++) map.set(ALPHABET[i], i);
  return map;
})();

function toU8(input) {
  if (input instanceof Uint8Array) return input;
  // Node Buffer is a Uint8Array subclass, but keep this for safety.
  if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(input)) return new Uint8Array(input);
  if (Array.isArray(input)) return Uint8Array.from(input);
  throw new Error("bs58.encode: expected Uint8Array/Buffer");
}

export function encode(bytes) {
  const source = toU8(bytes);
  if (!source.length) return "";

  // Count leading zeros.
  let zeros = 0;
  while (zeros < source.length && source[zeros] === 0) zeros++;

  // Convert base256 -> base58 using the "digits" method.
  const digits = [0];
  for (let i = zeros; i < source.length; i++) {
    let carry = source[i];
    for (let j = 0; j < digits.length; j++) {
      const x = digits[j] * 256 + carry;
      digits[j] = x % 58;
      carry = (x / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "";
  for (let i = 0; i < zeros; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export function decode(str) {
  const s = String(str || "");
  if (!s.length) return new Uint8Array(0);

  // Count leading ones.
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;

  const bytes = [0];
  for (let i = zeros; i < s.length; i++) {
    const ch = s[i];
    const val = ALPHABET_MAP.get(ch);
    if (val == null) throw new Error(`bs58.decode: invalid character '${ch}'`);

    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      const x = bytes[j] * 58 + carry;
      bytes[j] = x & 0xff;
      carry = x >> 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  // Leading zeros are already 0.
  for (let i = 0; i < bytes.length; i++) {
    out[out.length - 1 - i] = bytes[i];
  }
  return out;
}

// Match the bs58 package default export shape.
export const bs58 = { encode, decode };
export default bs58;
