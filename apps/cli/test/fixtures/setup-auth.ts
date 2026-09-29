import { runSetup } from "../../src/setup.ts";

// Real PTY, reducer and PKCE callback; only the browser/provider network is fake.
let attempt = 0;
try {
  const result = await runSetup({
    fetch: (async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/keys")) return Response.json({ key: "fixture-private-key" });
      if (url.endsWith("/key")) return Response.json({ data: {} });
      if (url.startsWith("https://openrouter.ai/")) return Response.json({ data: [{ id: "fixture/model", context_length: 262144, top_provider: { max_completion_tokens: 131072 } }] });
      throw new Error("Local fixture server is offline");
    }) as typeof fetch,
    openBrowser: async url => {
      if (process.argv.includes("--pending")) return false;
      const callback = new URL(new URL(url).searchParams.get("callback_url")!);
      callback.searchParams.set(process.argv.includes("--retry") && attempt++ === 0 ? "error" : "code", "fixture");
      await fetch(callback);
      return true;
    },
  });
  console.log(JSON.stringify(result));
} catch (error) { console.log(error instanceof Error ? error.message : "Setup failed"); }
