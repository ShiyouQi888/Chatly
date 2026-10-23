package com.example.chatly.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.chatly.ui.theme.ChatlyBg
import com.example.chatly.ui.theme.ChatlyText1
import com.example.chatly.ui.theme.ChatlyViolet

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiscoverScreen(
    onScanClick: () -> Unit = {}
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("发现", fontWeight = FontWeight.Bold, fontSize = 20.sp, color = ChatlyText1) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.White)
            )
        },
        containerColor = ChatlyBg
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            item {
                Spacer(modifier = Modifier.height(12.dp))
                DiscoverCell(icon = Icons.Default.Home, title = "动态朋友圈", tint = ChatlyViolet) {}
                HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
                Spacer(modifier = Modifier.height(12.dp))
                DiscoverCell(icon = Icons.Default.Star, title = "扫一扫", tint = Color(0xFF2563A8), onClick = onScanClick)
                HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
                DiscoverCell(icon = Icons.Default.Settings, title = "附近雷达", tint = Color(0xFF1E9E6A)) {}
            }
        }
    }
}

@Composable
fun DiscoverCell(icon: ImageVector, title: String, tint: Color, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.White)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(icon, contentDescription = title, tint = tint, modifier = Modifier.size(24.dp))
        Spacer(modifier = Modifier.width(16.dp))
        Text(text = title, fontSize = 16.sp, fontWeight = FontWeight.Medium, color = ChatlyText1, modifier = Modifier.weight(1f))
        Icon(Icons.Default.Menu, contentDescription = null, tint = Color(0xFF9A9AB0), modifier = Modifier.size(20.dp))
    }
}
