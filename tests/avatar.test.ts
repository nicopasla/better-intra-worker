import { describe, it, expect, beforeEach, vi } from "vitest";
import { Env } from "../src/types";
import {
  handleAvatarProxy,
  isValidAvatarLogin,
  mintAvatarUrl,
  photoPathFromUrl,
} from "../src/handlers/avatar";

vi.mock("../src/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils")>();
  return {
    ...actual,
    getAppToken: vi.fn(async () => "app-token"),
  };
});

vi.mock("../src/rate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rate")>();
  return { ...actual, fetchIntra: vi.fn() };
});

import { fetchIntra } from "../src/rate";

const ORIGIN = "https://api.betterintra.com";
const HASH = "a".repeat(32);
const PHOTO_PATH = `/users/${HASH}/photo.jpg`;
const PHOTO_URL = `https://cdn.intra.42.fr${PHOTO_PATH}`;

function makeEnv(secret: string = "test-secret"): Env {
  return {
    AVATAR_URL_SECRET: secret,
    better_intra_d1: {} as never,
    better_intra_images: {} as never,
    BETTER_INTRA_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as never,
    CLIENT_ID: "id",
    CLIENT_SECRET: "secret",
  };
}

function imageResponse(bytes = new Uint8Array([0xff, 0xd8, 0xff])): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "image/jpeg" },
  });
}

const cacheStore = new Map<string, Response>();

beforeEach(() => {
  cacheStore.clear();
  vi.mocked(fetchIntra).mockReset();
  vi.mocked(fetchIntra).mockResolvedValue(imageResponse());
  (globalThis as unknown as { caches: unknown }).caches = {
    default: {
      match: async (req: Request) => {
        const hit = cacheStore.get(new URL(req.url).pathname);
        return hit ? hit.clone() : undefined;
      },
      put: async (req: Request, res: Response) => {
        cacheStore.set(new URL(req.url).pathname, res.clone());
      },
    },
  };
});

describe("isValidAvatarLogin", () => {
  it("accepts typical logins", () => {
    expect(isValidAvatarLogin("jsmith")).toBe(true);
    expect(isValidAvatarLogin("a-b_c")).toBe(true);
    expect(isValidAvatarLogin("user42")).toBe(true);
  });

  it("rejects malformed or unsafe logins", () => {
    expect(isValidAvatarLogin("")).toBe(false);
    expect(isValidAvatarLogin("..")).toBe(false);
    expect(isValidAvatarLogin("a/b")).toBe(false);
    expect(isValidAvatarLogin("a.b")).toBe(false);
    expect(isValidAvatarLogin("Foo")).toBe(false);
    expect(isValidAvatarLogin("a".repeat(33))).toBe(false);
  });
});

describe("photoPathFromUrl", () => {
  it("accepts the per-photo CDN path", () => {
    expect(photoPathFromUrl(PHOTO_URL)).toBe(PHOTO_PATH);
  });

  it("rejects legacy or foreign URLs", () => {
    expect(photoPathFromUrl("https://cdn.intra.42.fr/users/jsmith.jpg")).toBe(
      null,
    );
    expect(photoPathFromUrl("https://example.com/users/a/photo.jpg")).toBe(
      null,
    );
    expect(photoPathFromUrl(PHOTO_URL + "?v=1")).toBe(null);
    expect(photoPathFromUrl(null)).toBe(null);
  });
});

describe("mintAvatarUrl", () => {
  it("returns null without a signing secret", async () => {
    expect(await mintAvatarUrl(makeEnv(""), "jsmith", ORIGIN, PHOTO_URL)).toBeNull();
  });

  it("returns null without a valid photo", async () => {
    expect(await mintAvatarUrl(makeEnv(), "jsmith", ORIGIN)).toBeNull();
    expect(
      await mintAvatarUrl(
        makeEnv(),
        "jsmith",
        ORIGIN,
        "https://cdn.intra.42.fr/users/jsmith.jpg",
      ),
    ).toBeNull();
  });

  it("returns a signed proxy URL carrying the photo path", async () => {
    const url = await mintAvatarUrl(makeEnv(), "JSmith", ORIGIN, PHOTO_URL);
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin).toBe(ORIGIN);
    expect(parsed.pathname).toBe("/api/v1/public/avatar/jsmith");
    expect(parsed.searchParams.get("p")).toBe(PHOTO_PATH);
    expect(parsed.searchParams.get("exp")).toMatch(/^\d+$/);
    expect(parsed.searchParams.get("sig")).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("handleAvatarProxy", () => {
  it("serves the image with the app token and caches it", async () => {
    const env = makeEnv();
    const url = await mintAvatarUrl(env, "jsmith", ORIGIN, PHOTO_URL);

    const res = await handleAvatarProxy(new Request(url!), env, "jsmith");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");

    expect(fetchIntra).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchIntra).mock.calls[0][1]).toBe(
      `https://cdn.intra.42.fr${PHOTO_PATH}`,
    );
    const init = vi.mocked(fetchIntra).mock.calls[0][2] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer app-token",
    );

    // Second request: the signature differs from the cache key, but the image
    // must come from the edge cache.
    const again = await handleAvatarProxy(new Request(url!), env, "jsmith");
    expect(again.status).toBe(200);
    expect(fetchIntra).toHaveBeenCalledTimes(1);
  });

  it("rejects a tampered signature", async () => {
    const env = makeEnv();
    const url = new URL((await mintAvatarUrl(env, "jsmith", ORIGIN, PHOTO_URL))!);
    url.searchParams.set("sig", "0".repeat(64));
    const res = await handleAvatarProxy(new Request(url), env, "jsmith");
    expect(res.status).toBe(403);
    expect(fetchIntra).not.toHaveBeenCalled();
  });

  it("rejects a swapped photo path", async () => {
    const env = makeEnv();
    const url = new URL((await mintAvatarUrl(env, "jsmith", ORIGIN, PHOTO_URL))!);
    url.searchParams.set("p", `/users/${"b".repeat(32)}/photo.jpg`);
    const res = await handleAvatarProxy(new Request(url), env, "jsmith");
    expect(res.status).toBe(403);
  });

  it("uses the relay when configured", async () => {
    const env = {
      ...makeEnv(),
      RELAY_URL: "https://relay.example.com/",
      RELAY_KEY: "relay-key",
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(imageResponse());
    const url = await mintAvatarUrl(env, "jsmith", ORIGIN, PHOTO_URL);
    const res = await handleAvatarProxy(new Request(url!), env, "jsmith");
    expect(res.status).toBe(200);

    const target = `https://cdn.intra.42.fr${PHOTO_PATH}`;
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      `https://relay.example.com?url=${encodeURIComponent(target)}`,
    );
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Relay-Key"]).toBe(
      "relay-key",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer app-token",
    );
    expect(fetchIntra).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects an expired link", async () => {
    const env = makeEnv();
    const url = new URL((await mintAvatarUrl(env, "jsmith", ORIGIN, PHOTO_URL))!);
    url.searchParams.set("exp", "1000");
    const res = await handleAvatarProxy(new Request(url), env, "jsmith");
    expect(res.status).toBe(403);
  });

  it("is unavailable without a signing secret", async () => {
    const env = makeEnv("");
    const res = await handleAvatarProxy(
      new Request(
        `${ORIGIN}/api/v1/public/avatar/jsmith?p=${encodeURIComponent(PHOTO_PATH)}&exp=9999999999&sig=${"0".repeat(64)}`,
      ),
      env,
      "jsmith",
    );
    expect(res.status).toBe(503);
  });

  it("falls back when the CDN does not return an image", async () => {
    const env = makeEnv();
    vi.mocked(fetchIntra).mockResolvedValueOnce(
      new Response("<html>blocked</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
    );
    const url = await mintAvatarUrl(env, "jsmith", ORIGIN, PHOTO_URL);
    const res = await handleAvatarProxy(new Request(url!), env, "jsmith");
    expect(res.status).toBe(502);
  });
});
