package expo.modules.liveactivity

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LiveActivityModule : Module() {
  private val channelId = "trip_live_activity"
  private val notificationId = 4102

  override fun definition() = ModuleDefinition {
    Name("LiveActivityModule")

    Function("isSupported") {
      appContext.reactContext != null
    }

    AsyncFunction("start") { state: Map<String, Any?> ->
      showOrUpdate(state)
      null
    }

    AsyncFunction("update") { state: Map<String, Any?> ->
      showOrUpdate(state)
      null
    }

    AsyncFunction("end") {
      appContext.reactContext?.let { context ->
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel(notificationId)
      }
      null
    }
  }

  private fun showOrUpdate(state: Map<String, Any?>) {
    val context = appContext.reactContext ?: return
    ensureChannel(context)

    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(notificationId, buildNotification(context, state))
  }

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(channelId) != null) return

    val channel = NotificationChannel(
      channelId,
      "Active trip",
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = "Ongoing trip status while navigation is active"
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(context: Context, state: Map<String, Any?>): Notification {
    val nextStop = state.stringValue("nextStopLabel", "Active trip")
    val eta = state.stringValue("etaText", "ETA unavailable")
    val drive = state.stringValue("driveRemainingText", "Drive time unavailable")
    val brk = state.stringValue("breakText", "Break status unavailable")
    val offRoute = state["offRoute"] as? Boolean ?: false
    val title = if (offRoute) "Off route: $nextStop" else nextStop
    val text = "$eta • $drive • $brk"
    val icon = context.applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_dialog_map
    val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val pendingIntent = launchIntent?.let {
      PendingIntent.getActivity(
        context,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()
      )
    }

    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(context, channelId)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }

    return builder
      .setSmallIcon(icon)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(Notification.BigTextStyle().bigText(text))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setCategory(Notification.CATEGORY_STATUS)
      .setPriority(Notification.PRIORITY_LOW)
      .apply {
        if (pendingIntent != null) setContentIntent(pendingIntent)
      }
      .build()
  }

  private fun immutableFlag(): Int {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_IMMUTABLE
    } else {
      0
    }
  }

  private fun Map<String, Any?>.stringValue(key: String, fallback: String): String {
    return (this[key] as? String)?.takeIf { it.isNotBlank() } ?: fallback
  }
}
