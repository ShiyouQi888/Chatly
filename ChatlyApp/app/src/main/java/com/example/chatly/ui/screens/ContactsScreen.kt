package com.example.chatly.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.*
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

data class ContactUser(
    val id: String,
    val name: String,
    val initial: String,
    val subtitle: String = "",
    val online: Boolean = true
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactsScreen(
    onContactClick: (String, String) -> Unit = { _, _ -> },
    onNewFriendsClick: () -> Unit = {}
) {
    var searchQuery by remember { mutableStateOf("") }

    val contactsList = remember {
        listOf(
            ContactUser("1", "Alice", "A", "前端架构师"),
            ContactUser("2", "Bob", "B", "后端研发负责人"),
            ContactUser("3", "Charlie", "C", "全栈开发", true),
            ContactUser("4", "David", "D", "测试工程师", false),
            ContactUser("5", "李四", "L", "UI/UX 设计师"),
            ContactUser("6", "张三", "Z", "技术总监")
        )
    }

    val filteredContacts = contactsList.filter {
        it.name.contains(searchQuery, ignoreCase = true) || it.subtitle.contains(searchQuery, ignoreCase = true)
    }

    val groupedContacts = filteredContacts.groupBy { it.initial }.toSortedMap()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("通讯录", fontWeight = FontWeight.Bold, fontSize = 20.sp, color = ChatlyText1) },
                actions = {
                    IconButton(onClick = {}) {
                        Icon(Icons.Default.Search, contentDescription = "搜索", tint = ChatlyText1)
                    }
                    IconButton(onClick = {}) {
                        Icon(Icons.Default.Add, contentDescription = "添加好友", tint = ChatlyText1)
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
                ContactSpecialRow(
                    icon = Icons.Default.Person,
                    title = "新的朋友",
                    badge = "2",
                    tint = ChatlyViolet,
                    onClick = onNewFriendsClick
                )
                HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
                ContactSpecialRow(
                    icon = Icons.Default.Star,
                    title = "群聊分组",
                    badge = "",
                    tint = Color(0xFF2563A8),
                    onClick = {}
                )
                Spacer(modifier = Modifier.height(12.dp))
            }

            groupedContacts.forEach { (initial, list) ->
                item {
                    Text(
                        text = initial,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        color = ChatlyTextMuted,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 6.dp)
                    )
                }

                items(list) { contact ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color.White)
                            .clickable { onContactClick(contact.id, contact.name) }
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Box(
                            modifier = Modifier
                                .size(44.dp)
                                .clip(RoundedCornerShape(14.dp))
                                .background(ChatlyViolet),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = contact.name.take(1),
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontSize = 17.sp
                            )
                        }
                        Spacer(modifier = Modifier.width(14.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = contact.name,
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 16.sp,
                                color = ChatlyText1
                            )
                            if (contact.subtitle.isNotEmpty()) {
                                Text(
                                    text = contact.subtitle,
                                    fontSize = 12.sp,
                                    color = ChatlyTextMuted
                                )
                            }
                        }
                    }
                    HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))
                }
            }
        }
    }
}

@Composable
fun ContactSpecialRow(
    icon: ImageVector,
    title: String,
    badge: String,
    tint: Color,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.White)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(tint),
            contentAlignment = Alignment.Center
        ) {
            Icon(icon, contentDescription = title, tint = Color.White, modifier = Modifier.size(22.dp))
        }
        Spacer(modifier = Modifier.width(16.dp))
        Text(
            text = title,
            fontSize = 16.sp,
            fontWeight = FontWeight.Medium,
            color = ChatlyText1,
            modifier = Modifier.weight(1f)
        )
        if (badge.isNotEmpty()) {
            Badge(containerColor = Color(0xFFC62F42)) {
                Text(text = badge, color = Color.White, fontSize = 11.sp)
            }
        }
    }
}
