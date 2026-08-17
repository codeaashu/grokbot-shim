import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import protobuf from "protobufjs";

import { jsonToStruct, jsonToValue } from "./struct.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = protobuf.loadSync(path.join(ROOT, "shim", "inference.proto"));
const StreamRequest = root.lookupType("aiserver.v1.InferenceStreamRequest");
const StreamResponse = root.lookupType("aiserver.v1.InferenceStreamResponse");

// usage: node shim/test-inference.mjs [model-id] [prompt] [--tools] [--history]
//   --tools    advertise a SendMessage tool
//   --history  prepend a completed tool call + tool result (multi-turn shape)
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const wantTools = flags.has("--tools") || flags.has("--history");
const [modelId = "canned", prompt = "Say hello from the shim test"] = argv.filter(
  (a) => !a.startsWith("--"),
);

const tools = wantTools
  ? [
      {
        name: "SendMessage",
        description: "Send a message to the user. This is the only way the user sees anything.",
        parameters: jsonToStruct({
          type: "object",
          properties: { message: { type: "string", description: "Markdown to show the user" } },
          required: ["message"],
        }),
      },
    ]
  : [];

const history = flags.has("--history")
  ? [
      { role: 1, text: "What is 2+2? Use ReadFile on notes.txt first." },
      {
        role: 2,
        text: "",
        toolCalls: [
          {
            toolCallId: "call_history_1",
            toolName: "ReadFile",
            rawToolCallArgs: JSON.stringify({ path: "notes.txt" }),
          },
        ],
      },
      {
        role: 3,
        toolContent: {
          parts: [
            {
              toolCallId: "call_history_1",
              toolName: "ReadFile",
              result: jsonToValue("notes.txt says: the answer is 4"),
            },
          ],
        },
      },
    ]
  : [];

const reqBytes = StreamRequest.encode(
  StreamRequest.fromObject({
    messages: [
      { role: 4, text: "You are an agent inside the sand desktop app." },
      ...history,
      { role: 1, text: prompt },
    ],
    tools,
    modelId,
    invocationId: "test-1",
    conversationId: "test-conversation",
  }),
).finish();

const env = Buffer.alloc(5 + reqBytes.length);
env[0] = 0x00;
env.writeUInt32BE(reqBytes.length, 1);
reqBytes.copy(env, 5);

const req = https.request(
  "https://localhost:8443/aiserver.v1.InferenceService/Stream",
  {
    method: "POST",
    headers: { "content-type": "application/connect+proto", authorization: "Bearer test" },
    rejectUnauthorized: false,
  },
  (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const buf = Buffer.concat(chunks);
      console.log("status:", res.statusCode, "ct:", res.headers["content-type"], "bytes:", buf.length);
      let off = 0;
      let text = "";
      while (off + 5 <= buf.length) {
        const flags = buf[off];
        const len = buf.readUInt32BE(off + 1);
        const payload = buf.subarray(off + 5, off + 5 + len);
        off += 5 + len;
        if (flags === 0x02) {
          console.log("[end frame]", payload.length ? payload.toString() : "(no trailers)");
          continue;
        }
        const msg = StreamResponse.decode(payload);
        const kind = msg.response;
        if (kind === "textPart") text += msg.textPart.text;
        else console.log(`[${kind}]`, JSON.stringify(msg[kind]?.toJSON?.() ?? msg[kind]));
      }
      console.log("STREAMED TEXT:", text);
    });
  },
);
req.end(env);
