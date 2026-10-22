/**
 * Send one Live Activity push from the command line.
 *
 *   APNS_TEAM_ID=... APNS_KEY_ID=... APNS_PRIVATE_KEY="$(cat AuthKey_XXXX.p8)" \
 *   APNS_BUNDLE_ID=com.example.tripactivity \
 *   pnpm push -- --token <hex push token from the app> --stop "Delivery — Example Co" --eta-minutes 42
 *
 * Without APNs credentials it prints the request it would send (dry run).
 */

import { parseArgs } from "node:util";
import {
  apnsLiveActivityConfig,
  buildLiveActivityPayload,
  sendApnsLiveActivityUpdate,
} from "./apns-live-activity";

const { values } = parseArgs({
  // `pnpm <script> -- --flag` forwards the literal "--"; drop it.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    token: { type: "string" },
    stop: { type: "string", default: "Delivery — Example Co, Macon GA" },
    "eta-minutes": { type: "string", default: "45" },
    drive: { type: "string", default: "Drive 3h 20m" },
    end: { type: "boolean", default: false },
    "time-zone": { type: "string" },
  },
});

const args = {
  liveActivityPushToken: values.token ?? "00".repeat(32),
  title: values.stop!,
  body: values.drive!,
  event: values.end ? ("end" as const) : ("update" as const),
  context: {
    etaAt: Date.now() + Number(values["eta-minutes"]) * 60_000,
    timeZone: values["time-zone"],
  },
};

const config = apnsLiveActivityConfig();
if (!config.configured || !values.token) {
  console.log("Dry run (set APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY and pass --token to send).\n");
  console.log(`POST ${config.host}/3/device/${args.liveActivityPushToken}`);
  console.log(`apns-topic: ${config.topic}`);
  console.log("apns-push-type: liveactivity");
  console.log(JSON.stringify(buildLiveActivityPayload(args), null, 2));
} else {
  const result = await sendApnsLiveActivityUpdate(args);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
