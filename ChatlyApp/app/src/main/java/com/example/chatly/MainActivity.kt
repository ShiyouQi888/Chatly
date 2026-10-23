package com.example.chatly

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.example.chatly.ui.components.ChatlyBottomBar
import com.example.chatly.ui.components.Screen
import com.example.chatly.ui.screens.*
import com.example.chatly.ui.theme.ChatlyTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            ChatlyTheme {
                val navController = rememberNavController()
                val navBackStackEntry by navController.currentBackStackEntryAsState()
                val currentRoute = navBackStackEntry?.destination?.route ?: Screen.Chat.route

                val showBottomBar = currentRoute in listOf(
                    Screen.Chat.route,
                    Screen.Moments.route,
                    Screen.Discover.route,
                    Screen.Me.route
                )

                Scaffold(
                    modifier = Modifier.fillMaxSize(),
                    bottomBar = {
                        if (showBottomBar) {
                            ChatlyBottomBar(
                                currentRoute = currentRoute,
                                onNavigate = { screen ->
                                    if (currentRoute != screen.route) {
                                        navController.navigate(screen.route) {
                                            popUpTo(navController.graph.startDestinationId) {
                                                saveState = true
                                            }
                                            launchSingleTop = true
                                            restoreState = true
                                        }
                                    }
                                }
                            )
                        }
                    }
                ) { innerPadding ->
                    NavHost(
                        navController = navController,
                        startDestination = Screen.Chat.route,
                        modifier = Modifier.padding(innerPadding)
                    ) {
                        composable(Screen.Chat.route) {
                            ChatListScreen(
                                onChatClick = { _, chatName ->
                                    navController.navigate("chat_room/$chatName")
                                }
                            )
                        }
                        composable("chat_room/{chatName}") { backStackEntry ->
                            val chatName = backStackEntry.arguments?.getString("chatName") ?: "聊天"
                            ChatRoomScreen(
                                chatTitle = chatName,
                                onBack = { navController.popBackStack() },
                                onInfoClick = { navController.navigate("group_settings/$chatName") }
                            )
                        }
                        composable(Screen.Moments.route) { MomentsScreen() }
                        composable(Screen.Discover.route) {
                            DiscoverScreen(
                                onScanClick = { navController.navigate("scan") }
                            )
                        }
                        composable(Screen.Me.route) {
                            MeScreen(
                                onSettingsClick = { navController.navigate("settings") },
                                onQrClick = { navController.navigate("my_qr") }
                            )
                        }
                        composable("contacts") {
                            ContactsScreen(
                                onContactClick = { _, contactName ->
                                    navController.navigate("user_profile/$contactName")
                                }
                            )
                        }
                        composable("scan") {
                            ScanScreen(
                                onBack = { navController.popBackStack() },
                                onMyQrClick = { navController.navigate("my_qr") }
                            )
                        }
                        composable("group_settings/{groupName}") { backStackEntry ->
                            val groupName = backStackEntry.arguments?.getString("groupName") ?: "群聊详情"
                            GroupSettingsScreen(
                                groupName = groupName,
                                onBack = { navController.popBackStack() }
                            )
                        }
                        composable("user_profile/{userName}") { backStackEntry ->
                            val userName = backStackEntry.arguments?.getString("userName") ?: "用户资料"
                            UserProfileScreen(
                                userName = userName,
                                onBack = { navController.popBackStack() },
                                onSendMessage = { name -> navController.navigate("chat_room/$name") }
                            )
                        }
                        composable("notice_center") {
                            NoticeCenterScreen(onBack = { navController.popBackStack() })
                        }
                        composable("settings") {
                            SettingsScreen(onBack = { navController.popBackStack() })
                        }
                        composable("my_qr") {
                            MyQrScreen(onBack = { navController.popBackStack() })
                        }
                    }
                }
            }
        }
    }
}
