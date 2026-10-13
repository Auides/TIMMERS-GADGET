export type SerializedIdentifierInput = {
  type: string;
  value: string;
};

/** Mirrors the database's current `upper(btrim(...))` identifier canonicalization. */
export function normalizeSerializedIdentifierValue(value: string) {
  const normalized = value.trim().toUpperCase();
  if (!normalized) throw new Error("A serialized identifier is required.");
  return normalized;
}

/**
 * Identifiers describe one physical unit. A unit cannot repeat a kind or a
 * normalized value.
 */
export function assertDistinctSerializedIdentifiers(identifiers: readonly SerializedIdentifierInput[]) {
  const types = new Set<string>();
  const values = new Set<string>();
  for (const identifier of identifiers) {
    const type = identifier.type.trim().toUpperCase();
    const value = normalizeSerializedIdentifierValue(identifier.value);
    if (types.has(type) || values.has(value)) {
      throw new Error("Serialized identifiers must be unique for each physical unit.");
    }
    types.add(type);
    values.add(value);
  }
}

/** Values are globally unique, while identifier kinds repeat across units. */
export function assertUniqueSerializedIdentifierValues(identifiers: readonly SerializedIdentifierInput[]) {
  const values = new Set<string>();
  for (const identifier of identifiers) {
    const value = normalizeSerializedIdentifierValue(identifier.value);
    if (values.has(value)) throw new Error("Serialized identifier values must be globally unique.");
    values.add(value);
  }
}
