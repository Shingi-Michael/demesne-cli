/// The model's own browser in a turn: each call is an ordinary step whose
/// words say what it did there, "Opened localhost:5173/login", "Clicked
/// button “Save”", "Typed “Ada” into textbox “Name”". The model acts by a
/// control's number, which says nothing to a person, so the row names the
/// control from what the browser answered.

interface BrowserStep { input: Record<string, unknown>; detail?: string; message?: string }

function answered(message: string | undefined): Record<string, unknown> {
  try { const value = JSON.parse(message ?? "") as unknown; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
}
const quoted = (what: string) => what.replace(/"([^"]*)"/g, "“$1”");

export function browserTarget(tool: BrowserStep): string {
  const action = tool.input.action, said = answered(tool.message);
  const control = typeof said.did === "string" && said.did && !said.did.includes("is on the page") ? quoted(said.did) : "";
  if (action === "click" || action === "hover") return control || tool.detail || "";
  if (action === "type") {
    const text = typeof tool.input.text === "string" && tool.input.text ? `“${tool.input.text.length > 40 ? `${tool.input.text.slice(0, 39)}…` : tool.input.text}”` : "";
    return control ? [text, `into ${control}`].filter(Boolean).join(" ") : tool.detail ?? text;
  }
  if ((action === "read" || action === "text" || action === "picture" || action === "back" || action === "forward" || action === "reload") && typeof said.title === "string") return said.title;
  return tool.detail ?? "";
}
