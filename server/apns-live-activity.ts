/**
 * APNs ActivityKit push for the trip Live Activity. Framework-agnostic Node:
 * no SDK, no web framework, configuration read from the environment (or an
 * env-shaped object you pass in), and an injectable HTTP/2 transport.
 *
 * Flow: the app starts the activity, iOS hands it a per-activity push token,
 * the app sends that token to your backend, and the backend calls
 * `sendApnsLiveActivityUpdate` whenever the trip changes — the lock screen and
 * Dynamic Island update even while the app is suspended.
 *
 * Environment:
 *   APNS_TEAM_ID       Apple Developer team id (10 chars)
 *   APNS_KEY_ID        id of the .p8 auth key
 *   APNS_PRIVATE_KEY   the .p8 contents (PEM). Literal "\n" sequences are
 *                      accepted so it fits on one line in a .env file.
 *   APNS_BUNDLE_ID     the APP's bundle id (not the extension's)
 *   APNS_ENVIRONMENT   "production" | anything else = sandbox
 *   APNS_HOST          optional override, e.g. a local mock server
 */

import { connect } from "node:http2";

export type LiveActivitySendResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; error: string; terminal?: boolean };

export type EnvSource = Record<string, string | undefined>;

export type ApnsLiveActivityConfig = ReturnType<typeof apnsLiveActivityConfig>;

function cleanEnv(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function base64UrlEncode(input: ArrayBuffer | string) {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function pemToArrayBuffer(pem: string) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function liveActivityProviderName() {
  return "apns_activitykit";
}

export function apnsLiveActivityConfig(env: EnvSource = process.env) {
  const teamId = cleanEnv(env.APNS_TEAM_ID);
  const keyId = cleanEnv(env.APNS_KEY_ID);
  const privateKey = cleanEnv(env.APNS_PRIVATE_KEY)?.replaceAll(
    "\\n",
    "\n",
  ) ?? null;
  const bundleId =
    cleanEnv(env.APNS_BUNDLE_ID) ??
    cleanEnv(env.IOS_BUNDLE_IDENTIFIER) ??
    "com.example.tripactivity";
  const environment =
    cleanEnv(env.APNS_ENVIRONMENT)?.toLowerCase() === "production"
      ? "production"
      : "sandbox";

  return {
    teamId,
    keyId,
    privateKey,
    bundleId,
    environment,
    host:
      cleanEnv(env.APNS_HOST) ??
      (environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com"),
    // Live Activity pushes go to the APP's topic with this suffix — not to the
    // widget extension's bundle id, which is the most common setup mistake.
    topic: `${bundleId}.push-type.liveactivity`,
    configured: teamId != null && keyId != null && privateKey != null,
  };
}

// APNs rejects provider tokens older than an hour and throttles clients that
// mint them more often than every 20 minutes (TooManyProviderTokenUpdates), so
// one token is reused per (team, key) for 50 minutes.
const JWT_TTL_MS = 50 * 60 * 1000;
const jwtCache = new Map<string, { token: string; issuedAt: number }>();

export function clearApnsJwtCache() {
  jwtCache.clear();
}

export async function apnsProviderJwt(
  config: { teamId: string; keyId: string; privateKey: string },
  now: number = Date.now(),
) {
  const cacheKey = `${config.teamId}:${config.keyId}`;
  const cached = jwtCache.get(cacheKey);
  if (cached && now - cached.issuedAt < JWT_TTL_MS) return cached.token;

  const header = base64UrlEncode(
    JSON.stringify({ alg: "ES256", kid: config.keyId }),
  );
  const claims = base64UrlEncode(
    JSON.stringify({
      iss: config.teamId,
      iat: Math.floor(now / 1000),
    }),
  );
  const signingInput = `${header}.${claims}`;
  // WebCrypto emits the raw r||s signature JWS wants (not DER), so no
  // conversion step is needed.
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(config.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  const token = `${signingInput}.${base64UrlEncode(signature)}`;
  jwtCache.set(cacheKey, { token, issuedAt: now });
  return token;
}

export type TripPushContext = {
  loadNumber?: string;
  etaAt?: number;
  etaDelayMinutes?: number;
  routeDeviationMiles?: number;
  stoppedNear?: string;
  /** IANA zone for the ETA text, e.g. "America/New_York". Default: server zone. */
  timeZone?: string;
};

// Must serialize to exactly the Swift ContentState in the generated extension
// (TripActivityAttributes.ContentState) — same keys, same types — or iOS drops
// the update silently.
export type TripContentState = {
  nextStopLabel: string;
  etaText: string;
  driveRemainingText: string;
  breakText: string;
  offRoute: boolean;
};

export function liveActivityContentState(args: {
  title: string;
  body: string;
  context?: TripPushContext;
}): TripContentState {
  const etaText = args.context?.etaAt
    ? `ETA ${new Date(args.context.etaAt).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: args.context.timeZone,
      })}`
    : args.context?.etaDelayMinutes
      ? `${args.context.etaDelayMinutes} min late`
      : "ETA unavailable";

  return {
    nextStopLabel: args.context?.loadNumber
      ? `Load #${args.context.loadNumber}`
      : args.title,
    etaText,
    driveRemainingText: args.body.slice(0, 48),
    breakText: args.context?.stoppedNear
      ? `Near ${args.context.stoppedNear}`
      : "Status active",
    offRoute: (args.context?.routeDeviationMiles ?? 0) > 0,
  };
}

export type ApnsRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type ApnsResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
};

/** Anything that can POST over HTTP/2. Injected in tests. */
export type ApnsTransport = (request: ApnsRequest) => Promise<ApnsResponse>;

/**
 * Default transport over `node:http2`. APNs only speaks HTTP/2; Node's global
 * `fetch` (undici) negotiates HTTP/1.1 unless explicitly configured otherwise,
 * so it cannot be the default here.
 */
export const http2Transport: ApnsTransport = (request) =>
  new Promise((resolve, reject) => {
    const url = new URL(request.url);
    const session = connect(url.origin);
    session.on("error", reject);
    const stream = session.request({
      ":method": "POST",
      ":path": `${url.pathname}${url.search}`,
      ...request.headers,
    });
    let status = 0;
    const headers: Record<string, string | undefined> = {};
    const chunks: Buffer[] = [];
    stream.on("response", (responseHeaders) => {
      status = Number(responseHeaders[":status"] ?? 0);
      for (const [name, value] of Object.entries(responseHeaders)) {
        if (!name.startsWith(":")) headers[name] = Array.isArray(value) ? value.join(", ") : value?.toString();
      }
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      session.close();
      resolve({ status, headers, body: Buffer.concat(chunks).toString("utf8") });
    });
    stream.on("error", (error) => {
      session.close();
      reject(error);
    });
    stream.end(request.body);
  });

export type SendLiveActivityArgs = {
  liveActivityPushToken: string;
  title: string;
  body: string;
  context?: TripPushContext;
  /** "update" (default) or "end". An end push dismisses the activity. */
  event?: "update" | "end";
  /** Also show an alert banner. Default true for updates, matching production. */
  alert?: boolean;
};

export function buildLiveActivityPayload(args: SendLiveActivityArgs, now: number = Date.now()) {
  const event = args.event ?? "update";
  const timestamp = Math.floor(now / 1000);
  return {
    aps: {
      timestamp,
      event,
      "content-state": liveActivityContentState(args),
      ...(event === "end" ? { "dismissal-date": timestamp } : {}),
      ...((args.alert ?? event === "update")
        ? {
            alert: {
              title: args.title,
              body: args.body,
              sound: "default",
            },
          }
        : {}),
    },
  };
}

export async function sendApnsLiveActivityUpdate(
  args: SendLiveActivityArgs,
  options: { env?: EnvSource; transport?: ApnsTransport; now?: number } = {},
): Promise<LiveActivitySendResult> {
  const config = apnsLiveActivityConfig(options.env);
  if (
    !config.configured ||
    !config.teamId ||
    !config.keyId ||
    !config.privateKey
  ) {
    return { ok: false, error: "APNs Live Activity is not fully configured" };
  }
  if (!/^[0-9a-f]+$/i.test(args.liveActivityPushToken)) {
    return { ok: false, error: "push token must be hex", terminal: true };
  }

  try {
    const now = options.now ?? Date.now();
    const jwt = await apnsProviderJwt(
      {
        teamId: config.teamId,
        keyId: config.keyId,
        privateKey: config.privateKey,
      },
      now,
    );
    const response = await (options.transport ?? http2Transport)({
      url: `${config.host}/3/device/${args.liveActivityPushToken}`,
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-topic": config.topic,
        "apns-push-type": "liveactivity",
        "apns-priority": "10",
        "content-type": "application/json",
      },
      body: JSON.stringify(buildLiveActivityPayload(args, now)),
    });

    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        error: `APNs HTTP ${response.status}${response.body ? `: ${response.body}` : ""}`,
        // 400 (bad token / payload) and 410 (activity ended) will never
        // succeed on retry; the caller should drop the stored token.
        terminal: response.status === 400 || response.status === 410,
      };
    }

    return {
      ok: true,
      providerMessageId: response.headers["apns-id"] ?? undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "APNs send failed",
    };
  }
}
