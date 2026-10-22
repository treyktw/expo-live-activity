/**
 * The APNs sender with no Apple account: a freshly generated P-256 key stands
 * in for the .p8, the JWT is verified with Node's own crypto, and requests go
 * to an injected transport or to a local HTTP/2 server.
 */

import { createPublicKey, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { createServer, type Http2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  apnsLiveActivityConfig,
  apnsProviderJwt,
  buildLiveActivityPayload,
  clearApnsJwtCache,
  http2Transport,
  liveActivityContentState,
  sendApnsLiveActivityUpdate,
  type ApnsRequest,
  type ApnsTransport,
} from "../server/apns-live-activity";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const TOKEN = "ab".repeat(32);

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    APNS_TEAM_ID: "TEAM123456",
    APNS_KEY_ID: "KEY1234567",
    // One-line form, as it would sit in a .env file.
    APNS_PRIVATE_KEY: privatePem.replaceAll("\n", "\\n"),
    APNS_BUNDLE_ID: "com.example.tripactivity",
    ...overrides,
  };
}

function decodeJwt(jwt: string) {
  const [header, claims, signature] = jwt.split(".");
  const json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  return { header: json(header), claims: json(claims), signingInput: `${header}.${claims}`, signature };
}

function verifyEs256(jwt: string, key: KeyObject) {
  const { signingInput, signature } = decodeJwt(jwt);
  return verify(
    "sha256",
    Buffer.from(signingInput),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
}

function recordingTransport(status = 200, body = ""): { transport: ApnsTransport; requests: ApnsRequest[] } {
  const requests: ApnsRequest[] = [];
  return {
    requests,
    transport: async (request) => {
      requests.push(request);
      return { status, body, headers: { "apns-id": "11111111-2222-3333-4444-555555555555" } };
    },
  };
}

beforeEach(() => clearApnsJwtCache());

describe("configuration from env", () => {
  it("defaults to sandbox and the app's live-activity topic", () => {
    const config = apnsLiveActivityConfig(env());
    expect(config.configured).toBe(true);
    expect(config.host).toBe("https://api.sandbox.push.apple.com");
    expect(config.topic).toBe("com.example.tripactivity.push-type.liveactivity");
    expect(config.privateKey).toContain("\n-----END PRIVATE KEY-----");
  });

  it("switches to production and honours a host override", () => {
    expect(apnsLiveActivityConfig(env({ APNS_ENVIRONMENT: "PRODUCTION" })).host).toBe(
      "https://api.push.apple.com",
    );
    expect(apnsLiveActivityConfig(env({ APNS_HOST: "http://127.0.0.1:1" })).host).toBe("http://127.0.0.1:1");
  });

  it("reports unconfigured instead of throwing, and sends nothing", async () => {
    const { transport, requests } = recordingTransport();
    const result = await sendApnsLiveActivityUpdate(
      { liveActivityPushToken: TOKEN, title: "t", body: "b" },
      { env: env({ APNS_KEY_ID: "  " }), transport },
    );
    expect(result).toEqual({ ok: false, error: "APNs Live Activity is not fully configured" });
    expect(requests).toHaveLength(0);
  });
});

describe("ES256 provider token", () => {
  it("is a valid JWS signed by the .p8 key, with kid and iss", async () => {
    const config = apnsLiveActivityConfig(env());
    const jwt = await apnsProviderJwt({
      teamId: config.teamId!,
      keyId: config.keyId!,
      privateKey: config.privateKey!,
    });
    const { header, claims } = decodeJwt(jwt);
    expect(header).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(claims.iss).toBe("TEAM123456");
    expect(typeof claims.iat).toBe("number");
    expect(verifyEs256(jwt, publicKey)).toBe(true);

    const otherKey = createPublicKey(
      generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
    );
    expect(verifyEs256(jwt, otherKey)).toBe(false);
  });

  it("is reused within 50 minutes and reminted after", async () => {
    const creds = { teamId: "T", keyId: "K", privateKey: privatePem };
    const t0 = Date.UTC(2026, 0, 1);
    const first = await apnsProviderJwt(creds, t0);
    expect(await apnsProviderJwt(creds, t0 + 49 * 60_000)).toBe(first);
    const later = await apnsProviderJwt(creds, t0 + 51 * 60_000);
    expect(later).not.toBe(first);
    expect(decodeJwt(later).claims.iat).toBe(Math.floor((t0 + 51 * 60_000) / 1000));
  });
});

describe("payload", () => {
  it("maps trip context onto the Swift ContentState fields", () => {
    expect(
      liveActivityContentState({
        title: "Delivery — Example Co",
        body: "Drive 3h 20m",
        context: {
          loadNumber: "1042",
          etaAt: Date.UTC(2026, 3, 14, 20, 12),
          timeZone: "UTC",
          routeDeviationMiles: 2.5,
          stoppedNear: "Exit 42",
        },
      }),
    ).toEqual({
      nextStopLabel: "Load #1042",
      etaText: "ETA 8:12 PM",
      driveRemainingText: "Drive 3h 20m",
      breakText: "Near Exit 42",
      offRoute: true,
    });
    expect(liveActivityContentState({ title: "x", body: "y", context: { etaDelayMinutes: 12 } }).etaText).toBe(
      "12 min late",
    );
  });

  it("builds update and end events", () => {
    const now = Date.UTC(2026, 3, 14, 12);
    const update = buildLiveActivityPayload({ liveActivityPushToken: TOKEN, title: "t", body: "b" }, now);
    expect(update.aps).toMatchObject({ event: "update", timestamp: now / 1000, alert: { title: "t" } });

    const end = buildLiveActivityPayload({ liveActivityPushToken: TOKEN, title: "t", body: "b", event: "end" }, now);
    expect(end.aps).toMatchObject({ event: "end", "dismissal-date": now / 1000 });
    expect("alert" in end.aps).toBe(false);
  });
});

describe("sendApnsLiveActivityUpdate", () => {
  it("POSTs to /3/device/<token> with the Live Activity headers", async () => {
    const { transport, requests } = recordingTransport();
    const result = await sendApnsLiveActivityUpdate(
      { liveActivityPushToken: TOKEN, title: "Next stop", body: "Drive 2h" },
      { env: env(), transport },
    );
    expect(result).toEqual({ ok: true, providerMessageId: "11111111-2222-3333-4444-555555555555" });

    const [request] = requests;
    expect(request.url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
    expect(request.headers["apns-topic"]).toBe("com.example.tripactivity.push-type.liveactivity");
    expect(request.headers["apns-push-type"]).toBe("liveactivity");
    expect(request.headers["apns-priority"]).toBe("10");
    expect(verifyEs256(request.headers.authorization.replace(/^bearer /, ""), publicKey)).toBe(true);
    expect(JSON.parse(request.body).aps["content-state"].nextStopLabel).toBe("Next stop");
  });

  it("marks 410 (activity gone) and 400 as terminal so the token gets dropped", async () => {
    for (const status of [400, 410]) {
      const { transport } = recordingTransport(status, '{"reason":"Unregistered"}');
      const result = await sendApnsLiveActivityUpdate(
        { liveActivityPushToken: TOKEN, title: "t", body: "b" },
        { env: env(), transport },
      );
      expect(result).toEqual({ ok: false, error: `APNs HTTP ${status}: {"reason":"Unregistered"}`, terminal: true });
    }
    const { transport } = recordingTransport(503, "");
    const retryable = await sendApnsLiveActivityUpdate(
      { liveActivityPushToken: TOKEN, title: "t", body: "b" },
      { env: env(), transport },
    );
    expect(retryable).toEqual({ ok: false, error: "APNs HTTP 503", terminal: false });
  });

  it("rejects a non-hex token before signing anything", async () => {
    const { transport, requests } = recordingTransport();
    const result = await sendApnsLiveActivityUpdate(
      { liveActivityPushToken: "../../etc", title: "t", body: "b" },
      { env: env(), transport },
    );
    expect(result).toMatchObject({ ok: false, terminal: true });
    expect(requests).toHaveLength(0);
  });

  it("returns transport errors instead of throwing", async () => {
    const result = await sendApnsLiveActivityUpdate(
      { liveActivityPushToken: TOKEN, title: "t", body: "b" },
      { env: env(), transport: async () => { throw new Error("socket hang up"); } },
    );
    expect(result).toEqual({ ok: false, error: "socket hang up" });
  });
});

describe("default HTTP/2 transport against a local server", () => {
  let server: Http2Server;
  let origin: string;
  const seen: Array<{ path: string; headers: Record<string, unknown>; body: string }> = [];

  beforeAll(async () => {
    server = createServer();
    server.on("stream", (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        seen.push({ path: String(headers[":path"]), headers, body: Buffer.concat(chunks).toString() });
        stream.respond({ ":status": 200, "apns-id": "local-apns-id" });
        stream.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("speaks HTTP/2 end to end", async () => {
    const result = await sendApnsLiveActivityUpdate(
      { liveActivityPushToken: TOKEN, title: "t", body: "b" },
      { env: env({ APNS_HOST: origin }), transport: http2Transport },
    );
    expect(result).toEqual({ ok: true, providerMessageId: "local-apns-id" });
    expect(seen[0].path).toBe(`/3/device/${TOKEN}`);
    expect(seen[0].headers["apns-push-type"]).toBe("liveactivity");
    expect(JSON.parse(seen[0].body).aps.event).toBe("update");
  });
});
