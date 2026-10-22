import ActivityKit
import ExpoModulesCore
import Foundation

private struct TripActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var nextStopLabel: String
    var etaText: String
    var driveRemainingText: String
    var breakText: String
    var offRoute: Bool
  }

  var tripId: String
}

@available(iOS 16.1, *)
private func contentState(from raw: [String: Any]) -> TripActivityAttributes.ContentState {
  TripActivityAttributes.ContentState(
    nextStopLabel: raw["nextStopLabel"] as? String ?? "Active trip",
    etaText: raw["etaText"] as? String ?? "ETA unavailable",
    driveRemainingText: raw["driveRemainingText"] as? String ?? "Drive time unavailable",
    breakText: raw["breakText"] as? String ?? "Break status unavailable",
    offRoute: raw["offRoute"] as? Bool ?? false
  )
}

@available(iOS 16.1, *)
private func currentTripActivity() -> Activity<TripActivityAttributes>? {
  Activity<TripActivityAttributes>.activities.first
}

private func hexToken(_ bytes: Data) -> String {
  bytes.map { String(format: "%02x", $0) }.joined()
}

@available(iOS 16.2, *)
private func firstPushToken(for activity: Activity<TripActivityAttributes>) async -> String? {
  for await tokenData in activity.pushTokenUpdates {
    return hexToken(tokenData)
  }
  return nil
}

public class LiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiveActivityModule")

    Function("isSupported") { () -> Bool in
      if #available(iOS 16.1, *) {
        return ActivityAuthorizationInfo().areActivitiesEnabled
      }
      return false
    }

    AsyncFunction("start") { (_ state: [String: Any]) async throws -> String? in
      guard #available(iOS 16.1, *) else { return nil }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { return nil }

      let nextState = contentState(from: state)
      if let existing = currentTripActivity() {
        if #available(iOS 16.2, *) {
          await existing.update(ActivityContent(state: nextState, staleDate: nil))
          return await firstPushToken(for: existing)
        } else {
          await existing.update(using: nextState)
          return nil
        }
      }

      let attributes = TripActivityAttributes(
        tripId: state["tripId"] as? String ?? UUID().uuidString
      )
      if #available(iOS 16.2, *) {
        let activity = try Activity.request(
          attributes: attributes,
          content: ActivityContent(state: nextState, staleDate: nil),
          pushType: .token
        )
        return await firstPushToken(for: activity)
      } else {
        _ = try Activity.request(
          attributes: attributes,
          contentState: nextState,
          pushType: nil
        )
        return nil
      }
    }

    AsyncFunction("update") { (_ state: [String: Any]) async -> Void in
      guard #available(iOS 16.1, *) else { return }
      guard let activity = currentTripActivity() else { return }

      let nextState = contentState(from: state)
      if #available(iOS 16.2, *) {
        await activity.update(ActivityContent(state: nextState, staleDate: nil))
      } else {
        await activity.update(using: nextState)
      }
    }

    AsyncFunction("end") { () async -> Void in
      guard #available(iOS 16.1, *) else { return }

      for activity in Activity<TripActivityAttributes>.activities {
        if #available(iOS 16.2, *) {
          await activity.end(nil, dismissalPolicy: .immediate)
        } else {
          await activity.end(dismissalPolicy: .immediate)
        }
      }
    }
  }
}
