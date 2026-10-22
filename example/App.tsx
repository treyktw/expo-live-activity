import { StatusBar } from "expo-status-bar";
import { useMemo, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import {
  isLiveActivityAvailable,
  useTripLiveActivity,
  type TripActivityState,
} from "live-activity";

// A fake trip so the screen works without a backend. In a real app these
// strings come from your routing / hours-of-service logic, already formatted.
const STOPS = [
  "Pickup — Example Foods, Dallas TX",
  "Fuel — Truck Stop, Jackson MS",
  "Delivery — Example Co, Atlanta GA",
];

function formatEta(minutesFromNow: number) {
  const eta = new Date(Date.now() + minutesFromNow * 60_000);
  return `ETA ${eta.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

export default function App() {
  const [active, setActive] = useState(false);
  const [stopIndex, setStopIndex] = useState(0);
  const [etaMinutes, setEtaMinutes] = useState(95);
  const [offRoute, setOffRoute] = useState(false);
  const [pushToken, setPushToken] = useState<string | null>(null);

  const state: TripActivityState | null = useMemo(
    () =>
      active
        ? {
            tripId: "trip_demo_1",
            nextStopLabel: STOPS[stopIndex],
            etaText: formatEta(etaMinutes),
            driveRemainingText: `Drive ${Math.floor((etaMinutes + 120) / 60)}h ${(etaMinutes + 120) % 60}m`,
            breakText: etaMinutes > 60 ? "Break in 1h 05m" : "Break due",
            offRoute,
          }
        : null,
    [active, stopIndex, etaMinutes, offRoute],
  );

  // In a real app, POST the token to your backend here; the backend then
  // calls sendApnsLiveActivityUpdate() from server/apns-live-activity.ts.
  useTripLiveActivity(active, state, ({ liveActivityPushToken }) => {
    setPushToken(liveActivityPushToken);
  });

  const available = isLiveActivityAvailable();

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="auto" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Trip Live Activity</Text>
        <Text style={styles.muted}>
          Native module: {available ? "available" : "not available (Expo Go, simulator without ActivityKit, or Live Activities disabled)"}
        </Text>

        <View style={styles.card}>
          <Text style={styles.label}>{state?.offRoute ? "Off route" : active ? "Next stop" : "No active trip"}</Text>
          <Text style={styles.stop}>{state?.nextStopLabel ?? "—"}</Text>
          <Text style={styles.muted}>
            {state ? `${state.etaText} · ${state.driveRemainingText} · ${state.breakText}` : "Start a trip to show it on the lock screen."}
          </Text>
        </View>

        {!active ? (
          <Button label="Start trip" onPress={() => setActive(true)} />
        ) : (
          <>
            <Button label="Update ETA (+15 min)" onPress={() => setEtaMinutes((m) => m + 15)} />
            <Button label="Update ETA (−15 min)" onPress={() => setEtaMinutes((m) => Math.max(5, m - 15))} />
            <Button
              label="Next stop"
              onPress={() => setStopIndex((i) => Math.min(STOPS.length - 1, i + 1))}
            />
            <View style={styles.row}>
              <Text>Off route</Text>
              <Switch value={offRoute} onValueChange={setOffRoute} />
            </View>
            <Button label="End trip" destructive onPress={() => {
              setActive(false);
              setStopIndex(0);
              setEtaMinutes(95);
              setOffRoute(false);
            }} />
          </>
        )}

        <Text style={styles.label}>APNs push token</Text>
        <Text selectable style={styles.mono}>
          {pushToken ?? "(appears after Start trip on iOS 16.2+)"}
        </Text>
        <Text style={styles.muted}>
          Send it a server-side update with: pnpm push -- --token {"<token>"}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Button(props: { label: string; onPress: () => void; destructive?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        props.destructive && styles.buttonDestructive,
        pressed && styles.buttonPressed,
      ]}
    >
      <Text style={styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 20, gap: 12 },
  title: { fontSize: 28, fontWeight: "700" },
  card: { borderRadius: 16, padding: 16, backgroundColor: "#16140f", gap: 4 },
  label: { fontSize: 12, color: "#8a877f", textTransform: "uppercase", letterSpacing: 0.5 },
  stop: { fontSize: 18, fontWeight: "600", color: "#ffffff" },
  muted: { color: "#8a877f" },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 },
  button: { backgroundColor: "#1f6f43", borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  buttonDestructive: { backgroundColor: "#a12d2d" },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: "#ffffff", fontWeight: "600", fontSize: 16 },
  mono: { fontFamily: "Courier", fontSize: 12 },
});
