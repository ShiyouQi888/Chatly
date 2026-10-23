package com.example.chatly.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.chatly.ui.theme.ChatlyAction
import com.example.chatly.ui.theme.ChatlyBg
import com.example.chatly.ui.theme.ChatlySuccess
import com.example.chatly.ui.theme.ChatlyText1
import com.example.chatly.ui.theme.ChatlyTextMuted
import com.example.chatly.ui.theme.ChatlyViolet
import com.example.chatly.ui.theme.squircleCornerRadius

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UserProfileScreen(
    userName: String = "Alice",
    onBack: () -> Unit,
    onSendMessage: (String) -> Unit = {}
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("个人资料", fontWeight = FontWeight.Bold, fontSize = 18.sp, color = ChatlyText1) },
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
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            Spacer(modifier = Modifier.height(12.dp))

            Surface(
                color = Color.White,
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(20.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box {
                        Box(
                            modifier = Modifier
                                .size(64.dp)
                                .clip(RoundedCornerShape(squircleCornerRadius(64.dp)))
                                .background(ChatlyViolet),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = userName.take(1),
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontSize = 28.sp
                            )
                        }
                        Box(
                            modifier = Modifier
                                .size(14.dp)
                                .clip(CircleShape)
                                .background(ChatlySuccess)
                                .align(Alignment.BottomEnd)
                        )
                    }

                    Spacer(modifier = Modifier.width(16.dp))

                    Column(modifier = Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = userName,
                                fontWeight = FontWeight.Bold,
                                fontSize = 20.sp,
                                color = ChatlyText1
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Surface(
                                color = Color(0xFFF0F0F7),
                                shape = RoundedCornerShape(4.dp)
                            ) {
                                Text(
                                    text = "在线",
                                    fontSize = 11.sp,
                                    color = ChatlySuccess,
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                                )
                            }
                        }
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = "Chatly ID: @${userName.lowercase()}_dev",
                            fontSize = 13.sp,
                            color = ChatlyTextMuted
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            ProfileCell(title = "设置备注与标签", value = "未设置") {}
            HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
            ProfileCell(title = "地区", value = "中国 · 北京") {}
            HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
            ProfileCell(title = "来源", value = "来自群聊《产品研发交流群》") {}

            Spacer(modifier = Modifier.height(28.dp))

            Box(modifier = Modifier.padding(horizontal = 16.dp)) {
                Button(
                    onClick = { onSendMessage(userName) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(50.dp),
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = ChatlyAction)
                ) {
                    Icon(Icons.Default.Star, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("发消息", fontSize = 16.sp, fontWeight = FontWeight.Bold)
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            Box(modifier = Modifier.padding(horizontal = 16.dp)) {
                OutlinedButton(
                    onClick = { },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(50.dp),
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = ChatlyViolet)
                ) {
                    Text("音视频通话", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@Composable
fun ProfileCell(title: String, value: String, onClick: () -> Unit) {
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
        Spacer(modifier = Modifier.width(6.dp))
        Icon(Icons.Default.Star, contentDescription = null, tint = Color(0xFF9A9AB0), modifier = Modifier.size(16.dp))
    }
}
