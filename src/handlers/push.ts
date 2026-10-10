import { Env, UserData, PushSubscription } from "../types";
import {
  getBearerToken,
  jsonRes,
  serializeUserData,
  textRes,
  validateSession,
} from "../utils";
import { buildEvalPush } from "./eval-notify";

const MAX_SUBSCRIPTIONS_PER_USER = 10;

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  /** Structured eval fields so the service worker can render local time. */
  kind?: "booked" | "revealed" | "corrected";
  beginAt?: string;
  project?: string | null;
  correcteds?: string[];
  corrector?: string;
}

// ---------------------------------------------------------------------------
// base64url helpers
// ---------------------------------------------------------------------------

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// VAPID (RFC 8292) + payload encryption (RFC 8291 / aes128gcm, RFC 8188)
// ---------------------------------------------------------------------------

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

async function importVapidPrivateKey(env: Env): Promise<CryptoKey> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    throw new Error("VAPID keys are not configured");
  }
  const publicBytes = base64UrlToBytes(env.VAPID_PUBLIC_KEY);
  if (publicBytes.byteLength !== 65 || publicBytes[0] !== 0x04) {
    throw new Error("Invalid VAPID public key");
  }
  const x = publicBytes.slice(1, 33);
  const y = publicBytes.slice(33, 65);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: bytesToBase64Url(x),
    y: bytesToBase64Url(y),
    d: env.VAPID_PRIVATE_KEY.replace(/=+$/, ""),
    ext: true,
  };
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function buildVapidHeaders(
  env: Env,
  endpoint: string,
): Promise<Record<string, string>> {
  const audience = new URL(endpoint).origin;
  const header = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const claims = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: env.VAPID_SUBJECT || "mailto:hello@betterintra.com",
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const key = await importVapidPrivateKey(env);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
  return {
    Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
  };
}

async function encryptPayload(
  uaPublicKey: Uint8Array,
  authSecret: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const uaPublic = await crypto.subtle.importKey(
    "raw",
    uaPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaPublic } as never,
      ephemeral.privateKey,
      256,
    ),
  );
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer,
  );

  const authInfo = concat(
    new TextEncoder().encode("WebPush: info\x00"),
    uaPublicKey,
    asPublic,
  );
  const ikm = await hkdf(ecdhSecret, authSecret, authInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(
    ikm,
    salt,
    new TextEncoder().encode("Content-Encoding: aes128gcm\x00"),
    16,
  );
  const nonce = await hkdf(
    ikm,
    salt,
    new TextEncoder().encode("Content-Encoding: nonce\x00"),
    12,
  );

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  // Single record: append the padding delimiter (0x02) to the plaintext.
  const record = concat(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(
    salt,
    recordSize,
    new Uint8Array([asPublic.byteLength]),
    asPublic,
    ciphertext,
  );
}

export interface PushSendResult {
  status: number;
  host: string;
  reason?: string;
}

/** Sends one Web Push message and reports how the push service answered. */
export async function sendWebPush(
  env: Env,
  sub: Pick<PushSubscription, "endpoint" | "p256dh" | "auth">,
  payload: PushPayload,
): Promise<PushSendResult> {
  let host = "unknown";
  try {
    host = new URL(sub.endpoint).host;
    const uaPublicKey = base64UrlToBytes(sub.p256dh);
    const authSecret = base64UrlToBytes(sub.auth);
    const body = await encryptPayload(
      uaPublicKey,
      authSecret,
      new TextEncoder().encode(JSON.stringify(payload)),
    );
    const vapid = await buildVapidHeaders(env, sub.endpoint);

    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        ...vapid,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "3600",
        Urgency: "high",
      },
      body,
    });

    let reason: string | undefined;
    if (!res.ok) {
      try {
        const errBody = (await res.json()) as { reason?: unknown };
        reason =
          typeof errBody?.reason === "string" ? errBody.reason : undefined;
      } catch {
        /* non-JSON error body */
      }
    }
    console.log(
      `[push] send host=${host} status=${res.status}${reason ? ` reason=${reason}` : ""}`,
    );
    return { status: res.status, host, reason };
  } catch (e) {
    console.warn(`[push] send failed host=${host}: ${e}`);
    return { status: 0, host };
  }
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

function auth(request: Request, existingData: UserData | null) {
  const token = getBearerToken(request);
  if (!token)
    return { error: textRes("Missing Authorization Token", 401), token: "" };
  if (!existingData)
    return { error: textRes("User not found", 404), token: "" };
  if (!validateSession(existingData, token))
    return {
      error: textRes("Unauthorized: Invalid Session Token", 401),
      token: "",
    };
  return { error: null, token };
}

export async function handlePushPublicKey(env: Env): Promise<Response> {
  if (!env.VAPID_PUBLIC_KEY) return jsonRes({ publicKey: null });
  return jsonRes({ publicKey: env.VAPID_PUBLIC_KEY });
}

export async function handlePushSubscribe(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);
  const { error } = auth(request, existingData);
  if (error) return error;

  let body: {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  try {
    body = await request.json();
  } catch {
    return textRes("Invalid JSON", 400);
  }

  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const authSecret = typeof body?.keys?.auth === "string" ? body.keys.auth : "";
  if (!/^https:\/\//.test(endpoint) || !p256dh || !authSecret) {
    return textRes("Invalid subscription", 400);
  }

  const ua = request.headers.get("User-Agent")?.slice(0, 120);
  const others = (existingData!.pushSubscriptions || []).filter(
    (s) => s.endpoint !== endpoint,
  );
  const updated: PushSubscription[] = [
    ...others,
    { endpoint, p256dh, auth: authSecret, ua, addedAt: Date.now() },
  ].slice(-MAX_SUBSCRIPTIONS_PER_USER);

  await env.BETTER_INTRA_KV.put(
    loginParam,
    serializeUserData({ ...existingData!, pushSubscriptions: updated }),
  );

  // Track this user in the eval cron (populates eval_states so both the
  // upcoming list and their push notifications work) even without Discord.
  await env.better_intra_d1
    .prepare(
      "INSERT INTO users (hash, evals_enabled) VALUES (?, 1) ON CONFLICT(hash) DO UPDATE SET evals_enabled = 1",
    )
    .bind(loginParam)
    .run();

  return jsonRes({ ok: true, count: updated.length });
}

export async function handlePushUnsubscribe(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);
  const { error } = auth(request, existingData);
  if (error) return error;

  let body: { endpoint?: unknown; all?: unknown };
  try {
    body = await request.json();
  } catch {
    return textRes("Invalid JSON", 400);
  }

  const current = existingData!.pushSubscriptions || [];
  const updated =
    body?.all === true
      ? []
      : current.filter((s) => s.endpoint !== body?.endpoint);

  await env.BETTER_INTRA_KV.put(
    loginParam,
    serializeUserData({ ...existingData!, pushSubscriptions: updated }),
  );
  return jsonRes({ ok: true, count: updated.length });
}

export async function handlePushTest(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);
  const { error } = auth(request, existingData);
  if (error) return error;

  let body: {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
    variant?: unknown;
  } = {};
  try {
    body = await request.json();
  } catch {
    /* body optional */
  }

  const target: PushSubscription | null =
    typeof body?.endpoint === "string" &&
    typeof body?.keys?.p256dh === "string" &&
    typeof body?.keys?.auth === "string"
      ? {
          endpoint: body.endpoint,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth as string,
          addedAt: Date.now(),
        }
      : ((existingData!.pushSubscriptions || [])[0] ?? null);

  if (!target) return textRes("No push subscription", 404);

  const testBeginAt = new Date(Date.now() + 15 * 60000).toISOString();
  const variant = typeof body?.variant === "string" ? body.variant : "";
  const payload: PushPayload =
    variant === "booked"
      ? {
          ...buildEvalPush({
            kind: "booked",
            project: null,
            beginAt: testBeginAt,
          }),
          url: "https://mobile.betterintra.com/",
          tag: "ft-test-booked",
        }
      : variant === "revealed"
        ? {
            ...buildEvalPush({
              kind: "revealed",
              project: "ft_transcendence",
              beginAt: testBeginAt,
              correcteds: ["elmo", "kermit"],
            }),
            url: "https://mobile.betterintra.com/",
            tag: "ft-test-revealed",
          }
        : {
            title: "Push test",
            body: "Push notifications are working 🎉",
            url: "https://mobile.betterintra.com/",
            tag: "ft-test",
          };

  const result = await sendWebPush(env, target, payload);

  const ok = result.status >= 200 && result.status < 300;
  if (result.status === 0) return textRes("Failed to reach push service", 502);
  return jsonRes({ ok, ...result, status: result.status }, ok ? 200 : 502);
}
