export const reasoning = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "opaque-reasoning" };
export const tool = { id: "fc_1", type: "function_call", call_id: "call_1", namespace: "demesne", name: "read_file", arguments: '{"path":"input.txt"}', status: "completed" };
export function responseStream(options: { model?: string; tool?: boolean; complete?: boolean; failure?: string; terminalOutput?: "full" | "empty" } = {}) {
  const events: unknown[] = [];
  if (options.tool) events.push(
    { type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: null } },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 2, item: { ...tool, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", output_index: 2, delta: tool.arguments },
    { type: "response.function_call_arguments.done", output_index: 2, item_id: tool.id, arguments: tool.arguments },
    { type: "response.output_item.done", output_index: 2, item: tool });
  const message = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "File inspected.", annotations: [] }] };
  if (!options.tool) events.push(
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", delta: "File inspected." },
    { type: "response.output_item.done", output_index: 0, item: message });
  if (options.failure) events.push({ type: "response.failed", response: { error: { code: options.failure } } });
  else if (options.complete !== false) events.push({ type: "response.completed", response: { ...(options.model ? { model: options.model } : {}), status: "completed", output: options.terminalOutput === "empty" ? [] : options.tool ? [reasoning, tool] : [message], usage: { input_tokens: 20, output_tokens: 15, total_tokens: 35, input_tokens_details: { cached_tokens: 8 } } } });
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
