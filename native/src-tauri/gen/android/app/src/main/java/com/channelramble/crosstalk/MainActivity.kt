package com.channelramble.crosstalk

import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    requestLocalNetworkIfNeeded()
  }

  /**
   * Android 17 (API 37) holds back connections to local-network addresses until the app has
   * ACCESS_LOCAL_NETWORK. Crosstalk talks to a hub that may live on the home network, so ask once.
   */
  private fun requestLocalNetworkIfNeeded() {
    if (Build.VERSION.SDK_INT < 37) return
    val permission = "android.permission.ACCESS_LOCAL_NETWORK"
    if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(permission), 4207)
    }
  }
}
