package com.example.chatly.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.chatly.ui.theme.ChatlyBg
import com.example.chatly.ui.theme.ChatlyText1
import com.example.chatly.ui.theme.ChatlyTextMuted
import com.example.chatly.ui.theme.ChatlyViolet

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MeScreen(
    onSettingsClick: () -> Unit = {},
    onQrClick: () -> Unit = {}
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("我", fontWeight = FontWeight.Bold, fontSize = 20.sp, color = ChatlyText1) },
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
                // Profile header card with QR code click
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color.White)
                        .clickable(onClick = onQrClick)
                        .padding(20.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        modifier = Modifier
                            .size(64.dp)
                            .clip(RoundedCornerShape(20.dp))
                            .background(ChatlyViolet),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(text = "D", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 28.sp)
                    }
                    Spacer(modifier = Modifier.width(16.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(text = "Developer", fontWeight = FontWeight.Bold, fontSize = 18.sp, color = ChatlyText1)
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(text = "Chatly ID: chatly_dev_01", fontSize = 14.sp, color = ChatlyTextMuted)
                    }
                }
                Spacer(modifier = Modifier.height(16.dp))
                MeCell(icon = Icons.Default.Person, title = "个人状态", tint = ChatlyViolet) {}
                HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
                MeCell(icon = Icons.Default.Lock, title = "隐私安全", tint = Color(0xFF2563A8)) {}
                Spacer(modifier = Modifier.height(16.dp))
                MeCell(icon = Icons.Default.Settings, title = "系统设置", tint = Color(0xFF6B6B82), onClick = onSettingsClick)
                HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
                MeCell(icon = Icons.Default.Info, title = "关于 Chatly", tint = ChatlyViolet) {}
            }
        }
    }
}

@Composable
fun MeCell(icon: ImageVector, title: String, tint: Color, onClick: () -> Unit) {
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
        Icon(Icons.Default.Star, contentDescription = null, tint = Color(0xFF9A9AB0), modifier = Modifier.size(20.dp))
    }
}
