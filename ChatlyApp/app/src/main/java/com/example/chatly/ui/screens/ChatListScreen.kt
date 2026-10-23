package com.example.chatly.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.chatly.ui.theme.*

data class ChatItem(
    val id: String,
    val name: String,
    val lastMessage: String,
    val time: String,
    val unreadCount: Int = 0,
    val isGroup: Boolean = false
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatListScreen(
    onChatClick: (String, String) -> Unit = { _, _ -> }
) {
    var isSearching by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }

    val allChats = remember {
        listOf(
            ChatItem("1", "产品研发交流群 (12)", "Alice: 已经部署到线上环境了，大家测试一下", "14:25", 3, true),
            ChatItem("2", "张三", "今晚一起去吃潮汕牛肉火锅吗？", "12:10", 1),
            ChatItem("3", "李四", "收到，文件已经发到群里了。", "昨天", 0),
            ChatItem("4", "Chatly 通知助手", "欢迎使用 Chatly 移动端聊天通讯系统！", "星期三", 0)
        )
    }

    val filteredChats = allChats.filter {
        it.name.contains(searchQuery, ignoreCase = true) || it.lastMessage.contains(searchQuery, ignoreCase = true)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    if (isSearching) {
                        OutlinedTextField(
                            value = searchQuery,
                            onValueChange = { searchQuery = it },
                            placeholder = { Text("搜索联系人或消息…", fontSize = 14.sp) },
                            singleLine = true,
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(46.dp),
                            shape = RoundedCornerShape(12.dp),
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = ChatlyViolet,
                                unfocusedBorderColor = Color(0x1417171F)
                            )
                        )
                    } else {
                        Text("Chatly", fontWeight = FontWeight.Bold, fontSize = 20.sp, color = ChatlyText1)
                    }
                },
                actions = {
                    IconButton(onClick = {
                        isSearching = !isSearching
                        if (!isSearching) searchQuery = ""
                    }) {
                        Icon(
                            imageVector = if (isSearching) Icons.Default.Close else Icons.Default.Search,
                            contentDescription = "搜索",
                            tint = ChatlyText1
                        )
                    }
                    if (!isSearching) {
                        IconButton(onClick = { }) {
                            Icon(Icons.Default.Add, contentDescription = "发起群聊", tint = ChatlyText1)
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.White)
            )
        },
        containerColor = ChatlyBg
    ) { padding ->
        if (filteredChats.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center
            ) {
                Text(text = "未找到匹配的会话", color = ChatlyTextMuted, fontSize = 14.sp)
            }
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            ) {
                items(filteredChats) { chat ->
                    ChatRowItem(chat = chat, onClick = { onChatClick(chat.id, chat.name) })
                }
            }
        }
    }
}

@Composable
fun ChatRowItem(chat: ChatItem, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.White)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(squircleCornerRadius(48.dp)))
                .background(ChatlyViolet),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = chat.name.take(1),
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = 18.sp
            )
        }

        Spacer(modifier = Modifier.width(12.dp))

        Column(
            modifier = Modifier.weight(1f)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = chat.name,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 16.sp,
                    color = ChatlyText1
                )
                Text(
                    text = chat.time,
                    fontSize = 12.sp,
                    color = ChatlyTextMuted
                )
            }
            Spacer(modifier = Modifier.height(4.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = chat.lastMessage,
                    fontSize = 14.sp,
                    color = ChatlyTextMuted,
                    maxLines = 1,
                    modifier = Modifier.weight(1f)
                )
                if (chat.unreadCount > 0) {
                    Spacer(modifier = Modifier.width(8.dp))
                    Badge(
                        containerColor = ChatlyViolet
                    ) {
                        Text(
                            text = chat.unreadCount.toString(),
                            color = Color.White,
                            fontSize = 11.sp
                        )
                    }
                }
            }
        }
    }
    HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
}
