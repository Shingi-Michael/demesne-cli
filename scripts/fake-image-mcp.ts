/// Local fixture producer: creates real PNG bytes without an image model.
import sharp from "sharp";
const send = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") send(request.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "image-fixture", version: "1" } });
    else if (request.method === "tools/list") send(request.id, { tools: [{ name: "create_image", description: "Create a demonstration PNG image artifact", inputSchema: { type: "object", properties: {} } }] });
    else if (request.method === "tools/call") void sharp({ create: { width: 640, height: 400, channels: 3, background: "#00d4ff" } }).png().toBuffer()
      .then((bytes) => send(request.id, { content: [{ type: "text", text: "Created a demonstration image." }, { type: "image", mimeType: "image/png", data: bytes.toString("base64") }] }))
      .catch((error) => send(request.id, { isError: true, content: [{ type: "text", text: String(error) }] }));
  }
});
