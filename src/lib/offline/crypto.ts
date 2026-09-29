export const OFFLINE_CRYPTO_VERSION = "v1" as const;
export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_SALT_BYTES = 16;
export const AES_GCM_IV_BYTES = 12;

export type EncryptedVaultValue = { ciphertext: string; iv: string };
export type OfflineCryptoService = {
  iterations: number;
  createEnrollmentMaterial: (passcode: string, context: Uint8Array) => Promise<{
    kdfSalt: string;
    wrappedVaultKey: string;
    wrapIv: string;
    vaultKey: CryptoKey;
  }>;
  unwrapVaultKey: (passcode: string, profile: { kdfSalt: string; wrappedVaultKey: string; wrapIv: string }, context: Uint8Array) => Promise<CryptoKey>;
  rewrapVaultKey: (vaultKey: CryptoKey, passcode: string, context: Uint8Array) => Promise<{ kdfSalt: string; wrappedVaultKey: string; wrapIv: string }>;
};

function requireWebCrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) throw new Error("Secure browser cryptography is unavailable.");
  return globalThis.crypto;
}

function randomBytes(length: number) {
  return requireWebCrypto().getRandomValues(new Uint8Array(length));
}

function bufferSource(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function offlineCryptoContext(userId: string, deviceId: string) {
  return new TextEncoder().encode(JSON.stringify({ cryptoVersion: OFFLINE_CRYPTO_VERSION, userId, deviceId }));
}

function validatePasscode(passcode: string) {
  if (passcode.length < 8) throw new Error("Offline passcodes must contain at least 8 characters.");
}

async function deriveKeyEncryptionKey(passcode: string, salt: Uint8Array, iterations: number) {
  validatePasscode(passcode);
  const crypto = requireWebCrypto();
  const passcodeKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: bufferSource(salt), iterations },
    passcodeKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function newVaultKey() {
  return requireWebCrypto().subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function wrapVaultKey(vaultKey: CryptoKey, keyEncryptionKey: CryptoKey, context: Uint8Array) {
  const crypto = requireWebCrypto();
  const iv = randomBytes(AES_GCM_IV_BYTES);
  // The DEK is exported only transiently to encrypt it; only its ciphertext is persisted.
  const rawVaultKey = await crypto.subtle.exportKey("raw", vaultKey);
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bufferSource(iv), additionalData: bufferSource(context) }, keyEncryptionKey, rawVaultKey);
  return { wrappedVaultKey: toBase64(new Uint8Array(wrapped)), wrapIv: toBase64(iv) };
}

async function unwrapVaultKey(passcode: string, profile: { kdfSalt: string; wrappedVaultKey: string; wrapIv: string }, context: Uint8Array, iterations: number) {
  const crypto = requireWebCrypto();
  const keyEncryptionKey = await deriveKeyEncryptionKey(passcode, fromBase64(profile.kdfSalt), iterations);
  const rawVaultKey = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bufferSource(fromBase64(profile.wrapIv)), additionalData: bufferSource(context) },
    keyEncryptionKey,
    fromBase64(profile.wrappedVaultKey),
  );
  // It remains memory-only. Extractability is required solely to re-wrap this same DEK on a passcode change.
  return crypto.subtle.importKey("raw", rawVaultKey, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export function createOfflineCryptoService(iterations = PBKDF2_ITERATIONS): OfflineCryptoService {
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("PBKDF2 iterations must be a positive integer.");
  return {
    iterations,
    async createEnrollmentMaterial(passcode, context) {
      const salt = randomBytes(PBKDF2_SALT_BYTES);
      const keyEncryptionKey = await deriveKeyEncryptionKey(passcode, salt, iterations);
      const vaultKey = await newVaultKey();
      const wrapped = await wrapVaultKey(vaultKey, keyEncryptionKey, context);
      return { kdfSalt: toBase64(salt), ...wrapped, vaultKey };
    },
    async unwrapVaultKey(passcode, profile, context) {
      return unwrapVaultKey(passcode, profile, context, iterations);
    },
    async rewrapVaultKey(vaultKey, passcode, context) {
      const salt = randomBytes(PBKDF2_SALT_BYTES);
      const keyEncryptionKey = await deriveKeyEncryptionKey(passcode, salt, iterations);
      return { kdfSalt: toBase64(salt), ...(await wrapVaultKey(vaultKey, keyEncryptionKey, context)) };
    },
  };
}

export const productionOfflineCrypto = createOfflineCryptoService();

/** Available for future encrypted local records. A fresh AES-GCM IV is generated for every call. */
export async function encryptVaultValue(vaultKey: CryptoKey, value: Uint8Array, context?: Uint8Array): Promise<EncryptedVaultValue> {
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const ciphertext = await requireWebCrypto().subtle.encrypt({ name: "AES-GCM", iv: bufferSource(iv), additionalData: context ? bufferSource(context) : undefined }, vaultKey, bufferSource(value));
  return { ciphertext: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv) };
}

export async function decryptVaultValue(vaultKey: CryptoKey, value: EncryptedVaultValue, context?: Uint8Array) {
  const plaintext = await requireWebCrypto().subtle.decrypt(
    { name: "AES-GCM", iv: bufferSource(fromBase64(value.iv)), additionalData: context ? bufferSource(context) : undefined },
    vaultKey,
    bufferSource(fromBase64(value.ciphertext)),
  );
  return new Uint8Array(plaintext);
}
