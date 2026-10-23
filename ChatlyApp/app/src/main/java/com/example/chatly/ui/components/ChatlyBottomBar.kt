package com.example.chatly.ui.components

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.example.chatly.ui.theme.ChatlyViolet

sealed class Screen(val route: String, val title: String, val icon: ImageVector) {
    object Chat : Screen("chat", "聊天", Icons.Default.Email)
    object Moments : Screen("moments", "动态", Icons.Default.Home)
    object Discover : Screen("discover", "发现", Icons.Default.Star)
    object Me : Screen("me", "我", Icons.Default.Person)
}

@Composable
fun ChatlyBottomBar(
    currentRoute: String,
    onNavigate: (Screen) -> Unit
) {
    val items = listOf(
        Screen.Chat,
        Screen.Moments,
        Screen.Discover,
        Screen.Me
    )

    NavigationBar(
        containerColor = androidx.compose.ui.graphics.Color.White,
        tonalElevation = 8.dp
    ) {
        items.forEach { screen ->
            val selected = currentRoute == screen.route
            NavigationBarItem(
                icon = { Icon(screen.icon, contentDescription = screen.title) },
                label = { Text(screen.title) },
                selected = selected,
                onClick = { onNavigate(screen) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = ChatlyViolet,
                    selectedTextColor = ChatlyViolet,
                    indicatorColor = androidx.compose.ui.graphics.Color(0xFFF3F1FE)
                )
            )
        }
    }
}
