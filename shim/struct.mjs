// protobufjs has no JSON mapping for google.protobuf.Struct/Value: decoding a
// Struct field yields the raw `{fields:{k:{stringValue:…}}}` form, and toJSON()
// keeps it that way. Tool schemas, tool-call args and tool results all ride in
// Struct/Value, so they need converting by hand in both directions.

function setKey(value) {
  if (value.kind) return value.kind; // oneof virtual, present on decoded messages
  for (const key of [
    "nullValue",
    "numberValue",
    "stringValue",
    "boolValue",
    "structValue",
    "listValue",
  ]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return key;
  }
  return undefined;
}

export function valueToJson(value) {
  if (value == null) return null;
  if (typeof value !== "object") return value;
  switch (setKey(value)) {
    case "nullValue":
      return null;
    case "numberValue":
      return value.numberValue;
    case "stringValue":
      return value.stringValue;
    case "boolValue":
      return value.boolValue;
    case "structValue":
      return structToJson(value.structValue) ?? {};
    case "listValue":
      return (value.listValue?.values ?? []).map(valueToJson);
    default:
      return null;
  }
}

export function structToJson(struct) {
  if (struct == null) return undefined;
  const fields = struct.fields;
  if (!fields) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(fields)) out[key] = valueToJson(value);
  return out;
}

export function jsonToValue(value) {
  if (value === null || value === undefined) return { nullValue: 0 };
  if (typeof value === "number") return { numberValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Array.isArray(value)) return { listValue: { values: value.map(jsonToValue) } };
  return { structValue: jsonToStruct(value) };
}

export function jsonToStruct(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj ?? {})) fields[key] = jsonToValue(value);
  return { fields };
}
