package com.example.chatly.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.chatly.ui.theme.ChatlyBg
import com.example.chatly.ui.theme.ChatlyText1
import com.example.chatly.ui.theme.ChatlyTextMuted
import com.example.chatly.ui.theme.ChatlyViolet

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit
) {
    var enterToSend by remember { mutableStateOf(true) }
    var swipeDelete by remember { mutableStateOf(true) }
    var autoDownload by remember { mutableStateOf(true) }
    var cacheSize by remember { mutableStateOf("1.25 MB") }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("系统设置", fontWeight = FontWeight.Bold, fontSize = 18.sp, color = ChatlyText1) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", tint = ChatlyText1)
                    }
                },
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
                
                // Group 1: General Preferences
                Text(
                    text = "通用偏好",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = ChatlyTextMuted,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)
                )
                SettingSwitchRow(
                    title = "回车键发送消息",
                    checked = enterToSend,
                    onCheckedChange = { enterToSend = it }
                )
                HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
                SettingSwitchRow(
                    title = "消息列表手势快捷划除",
                    checked = swipeDelete,
                    onCheckedChange = { swipeDelete = it }
                )
                HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
                SettingSwitchRow(
                    title = "自动下载聊天图片与文件",
                    checked = autoDownload,
                    onCheckedChange = { autoDownload = it }
                )

                Spacer(modifier = Modifier.height(16.dp))

                // Group 2: Storage & Cache
                Text(
                    text = "存储与缓存",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = ChatlyTextMuted,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)
                )
                SettingValueRow(
                    title = "清理本地缓存数据",
                    value = cacheSize,
                    onClick = { cacheSize = "0.00 MB" }
                )

                Spacer(modifier = Modifier.height(16.dp))

                // Group 3: Privacy & Security
                Text(
                    text = "隐私与安全",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = ChatlyTextMuted,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)
                )
                SettingArrowRow(title = "账号安全与密码修改") {}
                HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
                SettingArrowRow(title = "隐私权限控制与加好友验证") {}

                Spacer(modifier = Modifier.height(28.dp))

                // Logout button
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(Color.White)
                        .clickable {}
                        .padding(vertical = 16.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "退出当前账号",
                        color = Color(0xFFC62F42),
                        fontWeight = FontWeight.Bold,
                        fontSize = 16.sp
                    )
                }
                Spacer(modifier = Modifier.height(24.dp))
            }
        }
    }
}

@Composable
fun SettingSwitchRow(title: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.White)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text = title, fontSize = 15.sp, color = ChatlyText1, modifier = Modifier.weight(1f))
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White,
                checkedTrackColor = ChatlyViolet
            )
        )
    }
}

@Composable
fun SettingValueRow(title: String, value: String, onClick: () -> Unit) {
    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color.White)
                .clickable(onClick = onClick)
                .padding(horizontal = 16.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(text = title, fontSize = 15.sp, color = ChatlyText1, modifier = Modifier.weight(1f))
            Text(text = value, fontSize = 14.sp, color = ChatlyTextMuted)
        }
        HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
    }
}

@Composable
fun SettingArrowRow(title: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.White)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text = title, fontSize = 15.sp, color = ChatlyText1, modifier = Modifier.weight(1f))
        Icon(Icons.Default.Star, contentDescription = null, tint = Color(0xFF9A9AB0), modifier = Modifier.size(18.dp))
    }
}
