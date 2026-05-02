const BLOCK_SIZE = 4 * 1024 * 1024; // 4MB blocks
const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH = 32;
const TOKEN_LENGTH = 48;

function toHex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function asBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export async function hashContent(data: Uint8Array): Promise<string> {
  const hashBuf = await crypto.subtle.digest('SHA-256', asBuffer(data));
  return toHex(new Uint8Array(hashBuf));
}

export async function hashContentBlake3(data: Uint8Array): Promise<string> {
  const hashBuf = await crypto.subtle.digest('SHA-512', asBuffer(data));
  return toHex(new Uint8Array(hashBuf));
}

export function splitIntoBlocks(data: Uint8Array): Uint8Array[] {
  const blocks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += BLOCK_SIZE) {
    blocks.push(data.subarray(offset, offset + BLOCK_SIZE));
  }
  return blocks;
}

export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(salt);
  return salt;
}

export async function hashPassword(password: string, salt?: Uint8Array): Promise<{ hash: string; salt: string }> {
  const actualSalt = salt ?? generateSalt();
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', asBuffer(encoder.encode(password)), 'PBKDF2', false, ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: asBuffer(actualSalt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-512' },
    keyMaterial, 512
  );
  return {
    hash: toHex(new Uint8Array(derived)),
    salt: toHex(actualSalt),
  };
}

export async function verifyPassword(password: string, storedHash: string, saltHex: string): Promise<boolean> {
  const salt = fromHex(saltHex);
  const result = await hashPassword(password, salt);
  return result.hash === storedHash;
}

export async function deriveEncryptionKey(masterKey: Uint8Array, context: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', asBuffer(masterKey), 'PBKDF2', false, ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: asBuffer(encoder.encode(context)), iterations: 100_000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return new Uint8Array(derived);
}

export function generateNonce(): Uint8Array {
  const nonce = new Uint8Array(24);
  crypto.getRandomValues(nonce);
  return nonce;
}

export { BLOCK_SIZE };
