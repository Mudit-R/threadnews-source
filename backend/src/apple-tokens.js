const encoder = new TextEncoder();
const bytesToBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function base64UrlToBytes(value) {
  const encoded = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')), character => character.charCodeAt(0));
}
export function appleEncryptionKeyBytes(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/.test(value)) return null;
  try { const bytes = base64UrlToBytes(value); return bytes.length === 32 ? bytes : null; }
  catch { return null; }
}
async function keyFor(env, usage) {
  const bytes = appleEncryptionKeyBytes(env.APPLE_TOKEN_ENCRYPTION_KEY);
  if (!bytes) throw new Error('apple_token_encryption_unavailable');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [usage]);
}
const binding = userId => encoder.encode('threadnews:apple-refresh:v1:' + userId);

export async function encryptAppleRefreshToken(env, userId, token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 8192) throw new Error('invalid_apple_refresh_token');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: binding(userId), tagLength: 128 },
    await keyFor(env, 'encrypt'), encoder.encode(token));
  return JSON.stringify({ v: 1, iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(new Uint8Array(encrypted)) });
}
export async function decryptAppleRefreshToken(env, userId, stored) {
  if (typeof stored !== 'string' || stored.length > 16384) throw new Error('invalid_apple_token_record');
  const record = JSON.parse(stored);
  if (record.v !== 1 || typeof record.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(record.iv)
      || typeof record.ciphertext !== 'string' || !/^[A-Za-z0-9_-]{20,12000}$/.test(record.ciphertext)) throw new Error('invalid_apple_token_record');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlToBytes(record.iv), additionalData: binding(userId), tagLength: 128 },
    await keyFor(env, 'decrypt'), base64UrlToBytes(record.ciphertext));
  return new TextDecoder().decode(plaintext);
}
