import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(process.argv[2], "utf8");
const outFile = process.argv[3] ?? "inference.proto";

const SCALAR = {
  1: "double", 2: "float", 3: "int64", 4: "uint64", 5: "int32", 6: "fixed64",
  7: "fixed32", 8: "bool", 9: "string", 12: "bytes", 13: "uint32",
  15: "sfixed32", 16: "sfixed64", 17: "sint32", 18: "sint64",
};

function matchBracket(text, openIdx, open = "[", close = "]") {
  let depth = 0;
  let inStr = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced brackets");
}

const identProxy = new Proxy({}, {
  get: (_, name) =>
    name === "proto3" ? { getEnumType: (x) => x, util: {} } : String(name),
  has: () => true,
});
function evalLiteral(code) {
  const fn = new Function(
    "scope",
    `with (scope) { return (${code}); }`,
  );
  return fn(identProxy);
}

const enums = new Map();
for (const m of src.matchAll(/proto3\.util\.setEnumType\(([A-Za-z0-9_]+),\s*"([^"]+)",\s*(\[)/g)) {
  const [, ident, typeName, openAt] = m;
  const start = m.index + m[0].length - 1;
  const end = matchBracket(src, start);
  const values = evalLiteral(src.slice(start, end + 1));
  enums.set(ident, { typeName, values });
}

const messages = new Map();
for (const m of src.matchAll(/([A-Za-z0-9_]+)\.typeName\s*=\s*"([^"]+)"/g)) {
  messages.set(m[1], { typeName: m[2], fields: null });
}
for (const m of src.matchAll(/([A-Za-z0-9_]+)\.fields\s*=\s*proto3\.util\.newFieldList\(\(\)\s*=>\s*(\[)/g)) {
  const [, ident, openAt] = m;
  if (!messages.has(ident)) continue;
  const start = m.index + m[0].length - 1;
  const end = matchBracket(src, start);
  const fields = evalLiteral(src.slice(start, end + 1));
  messages.get(ident).fields = fields;
}

function fieldType(f) {
  if (f.kind === "scalar") return SCALAR[f.T] ?? `scalar${f.T}`;
  if (f.kind === "enum") {
    const name = typeof f.T === "string" ? f.T : f.T?.enumRef ?? "UnknownEnum";
    return name;
  }
  if (f.kind === "message") return typeof f.T === "string" ? f.T : "UnknownMessage";
  if (f.kind === "map") {
    const k = SCALAR[f.K];
    const v = f.V?.kind === "message" ? (typeof f.V.T === "string" ? f.V.T : "UnknownMessage") : SCALAR[f.V?.T];
    return `map<${k}, ${v}>`;
  }
  return "unknown";
}

const knownMessages = new Set([...messages.values()].map((v) => v.typeName));
const knownEnums = new Set([...enums.values()].map((v) => v.typeName));
const external = new Set();

const lines = ['syntax = "proto3";', "package aiserver.v1;", ""];
for (const { typeName, values } of enums.values()) {
  lines.push(`enum ${typeName.split(".").pop()} {`);
  for (const v of values) lines.push(`  ${v.name} = ${v.no};`);
  lines.push("}", "");
}
for (const { typeName, fields } of messages.values()) {
  if (fields == null) continue;
  const short = typeName.split(".").pop();
  lines.push(`message ${short} {`);
  const oneofs = new Map();
  const body = [];
  for (const f of fields) {
    let t = fieldType(f);
    if (!SCALAR[f.T] && f.kind === "message" && !knownMessages.has(`aiserver.v1.${t}`) && !["Struct", "Value", "ListValue", "NullValue"].includes(t)) {
      if (!messages.has(t)) external.add(t);
    }
    if (f.kind === "message" && ["Struct", "Value", "ListValue"].includes(t)) external.add(`google.protobuf.${t}`);
    const prefix = f.kind === "map" ? "" : f.repeated ? "repeated " : "";
    const decl = `  ${prefix}${t} ${f.name} = ${f.no};`;
    if (f.oneof) {
      if (!oneofs.has(f.oneof)) oneofs.set(f.oneof, []);
      oneofs.get(f.oneof).push(`    ${f.kind === "map" ? "" : ""}${t} ${f.name} = ${f.no};`);
    } else {
      body.push(decl);
    }
  }
  lines.push(...body);
  for (const [name, members] of oneofs) {
    lines.push(`  oneof ${name} {`, ...members, "  }");
  }
  lines.push("}", "");
}

fs.writeFileSync(outFile, lines.join("\n"));
console.log(`wrote ${outFile}: ${enums.size} enums, ${[...messages.values()].filter((m) => m.fields).length} messages`);
if (external.size) console.log("external refs:", [...external].join(", "));
