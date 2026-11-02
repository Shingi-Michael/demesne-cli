import { describe, expect, test } from "bun:test";
import QRCode from "qrcode";
import { checkServer, pairingLink, serverFromTailscale } from "./pair-iphone.ts";

describe("pairing the iPhone app", () => {
  test("the link carries the address and the token, encoded", () => {
    const link = new URL(pairingLink("https://pc.tail1234.ts.net:8443", "ab+c/d="));
    expect(link.protocol).toBe("demesne:");
    expect(link.searchParams.get("server")).toBe("https://pc.tail1234.ts.net:8443");
    expect(link.searchParams.get("token")).toBe("ab+c/d=");
  });

  test("the address comes from tailscale status, on the serve port", () => {
    expect(serverFromTailscale({ Self: { DNSName: "shingi1.tail1234.ts.net." } })).toBe("https://shingi1.tail1234.ts.net:8443");
    expect(serverFromTailscale({ Self: {} })).toBeNull();
    expect(serverFromTailscale(null)).toBeNull();
  });

  test("only an https Tailscale address is accepted", () => {
    expect(checkServer("https://shingi1.tail1234.ts.net:8443")).toBeNull();
    expect(checkServer("http://shingi1.tail1234.ts.net:8443")).toContain("https");
    expect(checkServer("https://my-pc.example.com")).toContain(".ts.net");
    expect(checkServer("pc")).toContain("isn't an address");
  });

  test("a 64-character token fits in a code a phone camera reads", async () => {
    const code = QRCode.create(pairingLink("https://shingi1.tail1234.ts.net:8443", "f".repeat(64)), { errorCorrectionLevel: "M" });
    expect(code.version).toBeLessThanOrEqual(10);
  });
});
