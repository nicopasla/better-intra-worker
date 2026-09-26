import { describe, it, expect } from "vitest";
import {
  describeUserAgent,
  getTokens,
  sanitizeDeviceName,
  serializeUserData,
  sessionIdForToken,
} from "../src/utils";
import type { UserData } from "../src/types";

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const FIREFOX_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:141.0) Gecko/20100101 Firefox/141.0";
const EDGE_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe("describeUserAgent", () => {
  it("detects browser and OS", () => {
    expect(describeUserAgent(CHROME_WIN)).toBe("Chrome 141 · Windows");
    expect(describeUserAgent(FIREFOX_MAC)).toBe("Firefox 141 · macOS");
    expect(describeUserAgent(EDGE_WIN)).toBe("Edge 141 · Windows");
    expect(describeUserAgent(SAFARI_IOS)).toBe("Mobile Safari 18 · iOS");
  });

  it("handles a missing user agent", () => {
    expect(describeUserAgent(null)).toBe("Unknown device");
    expect(describeUserAgent(undefined)).toBe("Unknown device");
  });
});

describe("sanitizeDeviceName", () => {
  it("accepts and normalizes whitespace", () => {
    expect(sanitizeDeviceName("Blue Fox")).toBe("Blue Fox");
    expect(sanitizeDeviceName("  Blue   Fox  ")).toBe("Blue Fox");
  });

  it("rejects invalid names", () => {
    expect(sanitizeDeviceName("")).toBeUndefined();
    expect(sanitizeDeviceName(null)).toBeUndefined();
    expect(sanitizeDeviceName("Blue-Fox")).toBeUndefined();
    expect(sanitizeDeviceName("Blue3")).toBeUndefined();
    expect(sanitizeDeviceName("x".repeat(33))).toBeUndefined();
    expect(sanitizeDeviceName("   ")).toBeUndefined();
  });
});

describe("sessionIdForToken", () => {
  it("is deterministic and distinct per token", async () => {
    const a = await sessionIdForToken("token-a");
    const b = await sessionIdForToken("token-a");
    const c = await sessionIdForToken("token-b");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("getTokens", () => {
  it("supports the array and legacy single-token shapes", () => {
    expect(getTokens({ sessionTokens: ["a", "b"] })).toEqual(["a", "b"]);
    expect(getTokens({ sessionToken: "legacy" })).toEqual(["legacy"]);
    expect(getTokens({})).toEqual([]);
  });
});

describe("serializeUserData", () => {
  it("normalizes tokens, drops legacy, and preserves sessionMeta", () => {
    const data: UserData = {
      sessionToken: "legacy-token",
      sessionMeta: {
        "legacy-token": {
          id: "id-1",
          label: "Firefox 141 · macOS",
          country: "BE",
          createdAt: 123,
        },
      },
      settings: { FOO: true },
      tokenBroken: true,
    } as UserData;

    const parsed = JSON.parse(serializeUserData(data));
    expect(parsed.sessionTokens).toEqual(["legacy-token"]);
    expect(parsed.sessionToken).toBeUndefined();
    expect(parsed.sessionMeta["legacy-token"].country).toBe("BE");
    expect(parsed.settings).toEqual({ FOO: true });
    expect(parsed.tokenBroken).toBe(true);
  });
});
