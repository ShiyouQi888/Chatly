package com.example.chatly.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
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
import com.example.chatly.ui.theme.*

data class MomentComment(
    val author: String,
    val text: String
)

data class MomentPost(
    val id: String,
    val author: String,
    val time: String,
    val content: String,
    val imageUrl: String? = null,
    var likesCount: Int = 0,
    var isLiked: Boolean = false,
    val comments: MutableList<MomentComment> = mutableListOf()
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MomentsScreen() {
    var showComposer by remember { mutableStateOf(false) }
    var composerText by remember { mutableStateOf("") }
    var actionToast by remember { mutableStateOf<String?>(null) }
    var activeCommentPostId by remember { mutableStateOf<String?>(null) }
    var commentInputText by remember { mutableStateOf("") }

    val posts = remember {
        mutableStateListOf(
            MomentPost(
                id = "1",
                author = "Alice",
                time = "20分钟前",
                content = "Chatly 移动端聊天通讯系统正式接入双驱动数据层！体验流畅的现代设计语言与实时消息同步。",
                imageUrl = "chatly_banner",
                likesCount = 12,
                isLiked = true,
                comments = mutableStateListOf(
                    MomentComment("张三", "太棒了！测试流程非常顺畅。"),
                    MomentComment("李四", "给 UI 设计与紫色主题点赞 👍")
                )
            ),
            MomentPost(
                id = "2",
                author = "张三",
                time = "2小时前",
                content = "今天和团队一起试吃了三里屯的潮汕牛肉火锅，味道非常正宗！火锅爱好者推荐。🥩🔥",
                imageUrl = null,
                likesCount = 8,
                isLiked = false,
                comments = mutableStateListOf(
                    MomentComment("Alice", "下周末我也去试试！")
                )
            )
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("动态", fontWeight = FontWeight.Bold, fontSize = 20.sp, color = ChatlyText1) },
                actions = {
                    IconButton(onClick = { showComposer = true }) {
                        Icon(Icons.Default.Star, contentDescription = "发布动态", tint = ChatlyText1)
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
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(200.dp)
                            .background(ChatlyViolet),
                        contentAlignment = Alignment.BottomEnd
                    ) {
                        Row(
                            modifier = Modifier.padding(16.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "Developer",
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontSize = 18.sp
                            )
                            Spacer(modifier = Modifier.width(12.dp))
                            Box(
                                modifier = Modifier
                                    .size(60.dp)
                                    .clip(RoundedCornerShape(squircleCornerRadius(60.dp)))
                                    .background(Color.White),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(text = "D", color = ChatlyViolet, fontWeight = FontWeight.Bold, fontSize = 24.sp)
                            }
                        }
                    }
                    Spacer(modifier = Modifier.height(12.dp))
                }

                items(posts) { post ->
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 6.dp),
                        colors = CardDefaults.cardColors(containerColor = Color.White),
                        shape = RoundedCornerShape(16.dp),
                        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    modifier = Modifier
                                        .size(40.dp)
                                        .clip(RoundedCornerShape(squircleCornerRadius(40.dp)))
                                        .background(ChatlyViolet),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Text(text = post.author.take(1), color = Color.White, fontWeight = FontWeight.Bold)
                                }
                                Spacer(modifier = Modifier.width(12.dp))
                                Column {
                                    Text(text = post.author, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = ChatlyText1)
                                    Text(text = post.time, fontSize = 12.sp, color = ChatlyTextMuted)
                                }
                            }

                            Spacer(modifier = Modifier.height(10.dp))

                            Text(text = post.content, color = ChatlyText1, fontSize = 15.sp, lineHeight = 22.sp)

                            if (post.imageUrl != null) {
                                Spacer(modifier = Modifier.height(10.dp))
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(160.dp)
                                        .clip(RoundedCornerShape(12.dp))
                                        .background(Color(0xFFE6E2FD)),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Text(text = "Chatly Moments Image", color = ChatlyViolet, fontWeight = FontWeight.Medium)
                                }
                            }

                            Spacer(modifier = Modifier.height(12.dp))

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.clickable {
                                        post.isLiked = !post.isLiked
                                        post.likesCount += if (post.isLiked) 1 else -1
                                    }
                                ) {
                                    Icon(
                                        imageVector = if (post.isLiked) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                                        contentDescription = "赞",
                                        tint = if (post.isLiked) Color(0xFFC62F42) else ChatlyTextMuted,
                                        modifier = Modifier.size(20.dp)
                                    )
                                    Spacer(modifier = Modifier.width(4.dp))
                                    Text(
                                        text = "${post.likesCount}",
                                        fontSize = 13.sp,
                                        color = if (post.isLiked) Color(0xFFC62F42) else ChatlyTextMuted
                                    )
                                }

                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.clickable { activeCommentPostId = post.id }
                                ) {
                                    Icon(
                                        imageVector = Icons.Default.Star,
                                        contentDescription = "评论",
                                        tint = ChatlyTextMuted,
                                        modifier = Modifier.size(18.dp)
                                    )
                                    Spacer(modifier = Modifier.width(4.dp))
                                    Text(text = "评论 (${post.comments.size})", fontSize = 13.sp, color = ChatlyTextMuted)
                                }
                            }

                            if (post.comments.isNotEmpty()) {
                                Spacer(modifier = Modifier.height(10.dp))
                                Surface(
                                    color = Color(0xFFF0F0F7),
                                    shape = RoundedCornerShape(8.dp),
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Column(modifier = Modifier.padding(10.dp)) {
                                        post.comments.forEach { c ->
                                            Row(modifier = Modifier.padding(vertical = 2.dp)) {
                                                Text(text = "${c.author}: ", fontWeight = FontWeight.Bold, fontSize = 13.sp, color = ChatlyViolet)
                                                Text(text = c.text, fontSize = 13.sp, color = ChatlyText1)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                item { Spacer(modifier = Modifier.height(16.dp)) }
            }

            if (showComposer) {
                ModalBottomSheet(
                    onDismissRequest = { showComposer = false },
                    containerColor = Color.White
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(20.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text("发表动态", fontWeight = FontWeight.Bold, fontSize = 18.sp, color = ChatlyText1)
                            Button(
                                onClick = {
                                    if (composerText.isNotBlank()) {
                                        posts.add(
                                            0,
                                            MomentPost(
                                                id = System.currentTimeMillis().toString(),
                                                author = "Developer",
                                                time = "刚刚",
                                                content = composerText,
                                                imageUrl = "sample_image"
                                            )
                                        )
                                        composerText = ""
                                        showComposer = false
                                        actionToast = "动态发布成功！"
                                    }
                                },
                                shape = RoundedCornerShape(10.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = ChatlyAction)
                            ) {
                                Text("发表", fontSize = 14.sp)
                            }
                        }

                        Spacer(modifier = Modifier.height(16.dp))

                        OutlinedTextField(
                            value = composerText,
                            onValueChange = { composerText = it },
                            placeholder = { Text("这一刻的想法…", color = ChatlyTextMuted) },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(120.dp),
                            shape = RoundedCornerShape(12.dp)
                        )

                        Spacer(modifier = Modifier.height(16.dp))

                        Row(verticalAlignment = Alignment.CenterVertically) {
                            IconButton(onClick = {}) {
                                Icon(Icons.Default.Star, contentDescription = "添加图片", tint = ChatlyViolet)
                            }
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("添加相册图片", fontSize = 13.sp, color = ChatlyTextMuted)
                        }
                        Spacer(modifier = Modifier.height(24.dp))
                    }
                }
            }

            activeCommentPostId?.let { postId ->
                val targetPost = posts.find { it.id == postId }
                AlertDialog(
                    onDismissRequest = { activeCommentPostId = null },
                    title = { Text("发表评论", fontSize = 16.sp, fontWeight = FontWeight.Bold) },
                    text = {
                        OutlinedTextField(
                            value = commentInputText,
                            onValueChange = { commentInputText = it },
                            placeholder = { Text("评论内容…") },
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(10.dp)
                        )
                    },
                    confirmButton = {
                        TextButton(
                            onClick = {
                                if (commentInputText.isNotBlank() && targetPost != null) {
                                    targetPost.comments.add(MomentComment("Developer", commentInputText))
                                    commentInputText = ""
                                    activeCommentPostId = null
                                    actionToast = "评论成功"
                                }
                            }
                        ) {
                            Text("发表", color = ChatlyViolet)
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { activeCommentPostId = null }) {
                            Text("取消", color = ChatlyTextMuted)
                        }
                    }
                )
            }

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
