package com.example.chatly.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.chatly.ui.theme.ChatlyAction
import com.example.chatly.ui.theme.ChatlyBg
import com.example.chatly.ui.theme.ChatlyText1
import com.example.chatly.ui.theme.ChatlyTextMuted
import com.example.chatly.ui.theme.ChatlyViolet
import com.example.chatly.ui.theme.squircleCornerRadius

data class NoticeItem(
    val id: String,
    val title: String,
    val content: String,
    val time: String,
    val isFriendRequest: Boolean = false,
    var handled: Boolean = false
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NoticeCenterScreen(
    onBack: () -> Unit
) {
    val notices = remember {
        mutableStateListOf(
            NoticeItem("1", "好友申请", "Bob 请求添加你为好友（附言：我是后端研发）", "10:15", isFriendRequest = true),
            NoticeItem("2", "系统通知", "Chatly 移动端客户端已成功接入 CDLS 规范与 REST 服务。", "昨天 18:30"),
            NoticeItem("3", "群公告", "《产品研发交流群》发布新公告：今晚 20:00 进行线上打包测试。", "星期三")
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("通知中心", fontWeight = FontWeight.Bold, fontSize = 18.sp, color = ChatlyText1) },
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
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            item { Spacer(modifier = Modifier.height(4.dp)) }
            items(notices) { notice ->
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = Color.White),
                    shape = RoundedCornerShape(16.dp),
                    elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(36.dp)
                                    .clip(RoundedCornerShape(squircleCornerRadius(36.dp)))
                                    .background(ChatlyViolet),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = notice.title.take(1),
                                    color = Color.White,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 14.sp
                                )
                            }
                            Spacer(modifier = Modifier.width(12.dp))
                            Column(modifier = Modifier.weight(1f)) {
                                Text(text = notice.title, fontWeight = FontWeight.Bold, fontSize = 15.sp, color = ChatlyText1)
                                Text(text = notice.time, fontSize = 11.sp, color = ChatlyTextMuted)
                            }
                        }

                        Spacer(modifier = Modifier.height(10.dp))
                        Text(text = notice.content, fontSize = 14.sp, color = ChatlyText1, lineHeight = 20.sp)

                        if (notice.isFriendRequest && !notice.handled) {
                            Spacer(modifier = Modifier.height(14.dp))
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.End
                            ) {
                                Button(
                                    onClick = { notice.handled = true },
                                    shape = RoundedCornerShape(10.dp),
                                    colors = ButtonDefaults.buttonColors(containerColor = ChatlyAction),
                                    modifier = Modifier.height(36.dp)
                                ) {
                                    Text("同意", fontSize = 13.sp)
                                }
                            }
                        } else if (notice.isFriendRequest && notice.handled) {
                            Spacer(modifier = Modifier.height(8.dp))
                            Text("已同意", fontSize = 12.sp, color = Color(0xFF1E9E6A), fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
            item { Spacer(modifier = Modifier.height(12.dp)) }
        }
    }
}
