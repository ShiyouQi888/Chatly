package com.example.chatly.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.chatly.ui.theme.ChatlyBg
import com.example.chatly.ui.theme.ChatlyText1
import com.example.chatly.ui.theme.ChatlyTextMuted
import com.example.chatly.ui.theme.ChatlyViolet
import com.example.chatly.ui.theme.squircleCornerRadius

data class GroupMember(
    val id: String,
    val name: String
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GroupSettingsScreen(
    groupName: String = "产品研发交流群",
    onBack: () -> Unit
) {
    var muteNotifications by remember { mutableStateOf(false) }
    var pinChat by remember { mutableStateOf(true) }
    var showMemberNames by remember { mutableStateOf(true) }
    var actionToast by remember { mutableStateOf<String?>(null) }

    val members = remember {
        listOf(
            GroupMember("1", "Alice"),
            GroupMember("2", "Bob"),
            GroupMember("3", "Charlie"),
            GroupMember("4", "David"),
            GroupMember("5", "张三"),
            GroupMember("6", "李四")
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("群聊详情", fontWeight = FontWeight.Bold, fontSize = 18.sp, color = ChatlyText1) },
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
        Box(modifier = Modifier.fillMaxSize()) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            ) {
                item {
                    Spacer(modifier = Modifier.height(12.dp))
                    
                    // Group Members Grid Container
                    Surface(
                        color = Color.White,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text(
                                text = "群成员 (${members.size + 1}人)",
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Bold,
                                color = ChatlyTextMuted,
                                modifier = Modifier.padding(bottom = 12.dp)
                            )
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(16.dp)
                            ) {
                                members.take(4).forEach { member ->
                                    GroupMemberCell(name = member.name)
                                }
                                // Invite Member Cell
                                Column(
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                    modifier = Modifier.clickable { actionToast = "已打开邀请好友进群界面" }
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .size(48.dp)
                                            .clip(RoundedCornerShape(squircleCornerRadius(48.dp)))
                                            .background(Color(0xFFF0F0F7)),
                                        contentAlignment = Alignment.Center
                                    ) {
                                        Icon(Icons.Default.Add, contentDescription = "邀请成员", tint = ChatlyViolet)
                                    }
                                    Spacer(modifier = Modifier.height(4.dp))
                                    Text("添加", fontSize = 12.sp, color = ChatlyTextMuted)
                                }
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    // Group Infos
                    GroupInfoRow(title = "群聊名称", value = groupName) {}
                    HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
                    GroupInfoRow(title = "群公告", value = "欢迎大家在群内讨论 Chatly 研发。") {}
                    HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
                    GroupInfoRow(title = "群文件与共享文件", value = "4 个文件") {}

                    Spacer(modifier = Modifier.height(12.dp))

                    // Group Switches
                    SettingSwitchRow(title = "消息免打扰", checked = muteNotifications) { muteNotifications = it }
                    HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
                    SettingSwitchRow(title = "置顶聊天", checked = pinChat) { pinChat = it }
                    HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
                    SettingSwitchRow(title = "显示群成员昵称", checked = showMemberNames) { showMemberNames = it }

                    Spacer(modifier = Modifier.height(24.dp))

                    // Danger Actions
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color.White)
                            .clickable { actionToast = "已清空该群聊记录" }
                            .padding(vertical = 14.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(text = "清空聊天记录", color = Color(0xFFC62F42), fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    }

                    Spacer(modifier = Modifier.height(10.dp))

                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color.White)
                            .clickable {
                                actionToast = "已退出群聊"
                                onBack()
                            }
                            .padding(vertical = 14.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(text = "解散并退出群聊", color = Color(0xFFC62F42), fontSize = 15.sp, fontWeight = FontWeight.Bold)
                    }

                    Spacer(modifier = Modifier.height(24.dp))
                }
            }

            // Toast feedback
            actionToast?.let { msg ->
                LaunchedEffect(msg) {
                    kotlinx.coroutines.delay(2000)
                    actionToast = null
                }
                Surface(
                    color = Color(0xE617171F),
                    shape = RoundedCornerShape(20.dp),
                    modifier = Modifier
                        .align(Alignment.Center)
                        .padding(24.dp)
                ) {
                    Text(
                        text = msg,
                        color = Color.White,
                        fontSize = 13.sp,
                        modifier = Modifier.padding(horizontal = 18.dp, vertical = 10.dp)
                    )
                }
            }
        }
    }
}

@Composable
fun GroupMemberCell(name: String) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(squircleCornerRadius(48.dp)))
                .background(ChatlyViolet),
            contentAlignment = Alignment.Center
        ) {
            Text(text = name.take(1), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        }
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = name,
            fontSize = 12.sp,
            color = ChatlyText1,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
fun GroupInfoRow(title: String, value: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.White)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text = title, fontSize = 15.sp, color = ChatlyText1, modifier = Modifier.weight(1f))
        Text(
            text = value,
            fontSize = 14.sp,
            color = ChatlyTextMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 180.dp)
        )
        Spacer(modifier = Modifier.width(6.dp))
        Icon(Icons.Default.Star, contentDescription = null, tint = Color(0xFF9A9AB0), modifier = Modifier.size(16.dp))
    }
}
