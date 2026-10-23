package com.example.chatly.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
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

enum class MessageType {
    TEXT, IMAGE, VOICE, LOCATION, POLL, FILE
}

data class PollOption(
    val id: Int,
    val text: String,
    var votes: Int
)

data class MessageItem(
    val id: String,
    val sender: String,
    val text: String,
    val isMe: Boolean,
    val time: String,
    val type: MessageType = MessageType.TEXT,
    val isSystem: Boolean = false,
    var isRevoked: Boolean = false,
    val quotedSender: String? = null,
    val quotedText: String? = null,
    val voiceDurationSeconds: Int = 0,
    var isVoicePlaying: Boolean = false,
    val locationTitle: String? = null,
    val locationAddress: String? = null,
    val fileName: String? = null,
    val fileSize: String? = null,
    val pollQuestion: String? = null,
    val pollOptions: MutableList<PollOption> = mutableListOf()
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatRoomScreen(
    chatTitle: String = "产品研发交流群 (12)",
    onBack: () -> Unit,
    onInfoClick: () -> Unit = {}
) {
    var textInput by remember { mutableStateOf("") }
    var showMorePanel by remember { mutableStateOf(false) }
    var showEmojiPanel by remember { mutableStateOf(false) }
    var isVoiceMode by remember { mutableStateOf(false) }
    var replyingToMessage by remember { mutableStateOf<MessageItem?>(null) }
    var activeMessageForMenu by remember { mutableStateOf<MessageItem?>(null) }
    var actionToast by remember { mutableStateOf<String?>(null) }

    val emojis = listOf("😊", "👍", "🎉", "🔥", "❤️", "🚀", "👏", "💯", "🍻", "🥑", "潮", "汕")

    val messages = remember {
        mutableStateListOf(
            MessageItem("1", "", "—— 2026年10月22日 14:20 ——", false, "", isSystem = true),
            MessageItem(
                id = "2",
                sender = "Alice",
                text = "大家下午好！新版前端已与 REST + WebSocket 后端接通。",
                isMe = false,
                time = "14:20"
            ),
            MessageItem(
                id = "3",
                sender = "张三",
                text = "今晚大家聚餐选哪里？发个投票大家选一下。",
                isMe = false,
                time = "14:22",
                type = MessageType.POLL,
                pollQuestion = "今晚团队聚餐地点投票",
                pollOptions = mutableStateListOf(
                    PollOption(1, "潮汕牛肉火锅 (三里屯店)", 5),
                    PollOption(2, "日式居酒屋 (国贸店)", 2),
                    PollOption(3, "川味麻辣火锅 (望京店)", 3)
                )
            ),
            MessageItem(
                id = "4",
                sender = "李四",
                text = "[语音消息]",
                isMe = false,
                time = "14:23",
                type = MessageType.VOICE,
                voiceDurationSeconds = 8
            ),
            MessageItem(
                id = "5",
                sender = "张三",
                text = "[位置共享]",
                isMe = false,
                time = "14:24",
                type = MessageType.LOCATION,
                locationTitle = "潮汕牛肉火锅店 (三里屯店)",
                locationAddress = "北京市朝阳区三里屯路19号院4号楼"
            ),
            MessageItem(
                id = "6",
                sender = "我",
                text = "好的，我把 Chatly 架构设计文档发在群里了。",
                isMe = true,
                time = "14:25",
                type = MessageType.FILE,
                fileName = "Chatly_Architecture_v1.0.pdf",
                fileSize = "2.4 MB"
            )
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onInfoClick() }
                    ) {
                        Box(
                            modifier = Modifier
                                .size(34.dp)
                                .clip(RoundedCornerShape(squircleCornerRadius(34.dp)))
                                .background(ChatlyViolet),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = chatTitle.take(1),
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontSize = 15.sp
                            )
                        }
                        Spacer(modifier = Modifier.width(10.dp))
                        Column(verticalArrangement = Arrangement.Center) {
                            Text(
                                text = chatTitle,
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 16.sp,
                                color = ChatlyText1,
                                maxLines = 1
                            )
                            Text(
                                text = if (chatTitle.contains("(")) "12 位成员" else "在线",
                                fontSize = 11.sp,
                                color = ChatlyTextMuted
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", tint = ChatlyText1)
                    }
                },
                actions = {
                    IconButton(onClick = onInfoClick) {
                        Icon(Icons.Default.MoreVert, contentDescription = "更多设置", tint = ChatlyText1)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color(0xF2F7F7FB))
            )
        },
        bottomBar = {
            Surface(
                tonalElevation = 8.dp,
                color = Color(0xFFFBFBFE)
            ) {
                Column {
                    // Quoted Message Banner
                    replyingToMessage?.let { replyTarget ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(Color(0xFFF0F0F7))
                                .padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "回复 ${replyTarget.sender}: ${replyTarget.text}",
                                fontSize = 12.sp,
                                color = ChatlyText2,
                                maxLines = 1,
                                modifier = Modifier.weight(1f)
                            )
                            IconButton(
                                onClick = { replyingToMessage = null },
                                modifier = Modifier.size(20.dp)
                            ) {
                                Icon(Icons.Default.Close, contentDescription = "取消引用", tint = ChatlyTextMuted)
                            }
                        }
                    }

                    // Main Input Control Bar
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        // Voice Switch Button
                        IconButton(onClick = { isVoiceMode = !isVoiceMode }) {
                            Icon(
                                imageVector = Icons.Default.Menu,
                                contentDescription = "切换语音",
                                tint = ChatlyText2
                            )
                        }

                        if (isVoiceMode) {
                            Button(
                                onClick = { actionToast = "录音完成，已发送 5\" 语音" },
                                modifier = Modifier
                                    .weight(1f)
                                    .height(48.dp),
                                shape = RoundedCornerShape(14.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFE8E8F2))
                            ) {
                                Text("按住 说话", color = ChatlyText1, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                            }
                        } else {
                            OutlinedTextField(
                                value = textInput,
                                onValueChange = { textInput = it },
                                placeholder = { Text("发送消息…", color = ChatlyTextMuted, fontSize = 14.sp) },
                                modifier = Modifier
                                    .weight(1f)
                                    .height(48.dp),
                                shape = RoundedCornerShape(14.dp),
                                singleLine = true,
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = ChatlyViolet,
                                    unfocusedBorderColor = Color(0x1417171F)
                                )
                            )
                        }

                        // Emoji Button
                        IconButton(onClick = {
                            showEmojiPanel = !showEmojiPanel
                            showMorePanel = false
                        }) {
                            Icon(
                                imageVector = Icons.Default.Star,
                                contentDescription = "表情",
                                tint = if (showEmojiPanel) ChatlyViolet else ChatlyText2
                            )
                        }

                        // Plus Panel Toggle
                        IconButton(onClick = {
                            showMorePanel = !showMorePanel
                            showEmojiPanel = false
                        }) {
                            Icon(
                                imageVector = Icons.Default.Add,
                                contentDescription = "更多",
                                tint = if (showMorePanel) ChatlyViolet else ChatlyText2
                            )
                        }

                        // Send Button
                        if (!isVoiceMode) {
                            IconButton(
                                onClick = {
                                    if (textInput.isNotBlank()) {
                                        messages.add(
                                            MessageItem(
                                                id = System.currentTimeMillis().toString(),
                                                sender = "我",
                                                text = textInput,
                                                isMe = true,
                                                time = "刚刚",
                                                quotedSender = replyingToMessage?.sender,
                                                quotedText = replyingToMessage?.text
                                            )
                                        )
                                        textInput = ""
                                        replyingToMessage = null
                                    }
                                },
                                modifier = Modifier
                                    .size(40.dp)
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(ChatlyAction)
                            ) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Filled.Send,
                                    contentDescription = "发送",
                                    tint = Color.White,
                                    modifier = Modifier.size(18.dp)
                                )
                            }
                        }
                    }

                    // Emoji Drawer
                    if (showEmojiPanel) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(Color(0xFFF0F0F7))
                                .padding(12.dp),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            emojis.forEach { emoji ->
                                Text(
                                    text = emoji,
                                    fontSize = 22.sp,
                                    modifier = Modifier
                                        .clickable { textInput += emoji }
                                        .padding(4.dp)
                                )
                            }
                        }
                    }

                    // Attachment Drawer
                    if (showMorePanel) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(Color(0xFFF0F0F7))
                                .padding(vertical = 16.dp, horizontal = 24.dp),
                            horizontalArrangement = Arrangement.SpaceAround
                        ) {
                            ActionShortcut(icon = Icons.Default.Star, label = "图片") {
                                messages.add(
                                    MessageItem(
                                        id = System.currentTimeMillis().toString(),
                                        sender = "我",
                                        text = "[图片]",
                                        isMe = true,
                                        time = "刚刚",
                                        type = MessageType.IMAGE
                                    )
                                )
                                showMorePanel = false
                            }
                            ActionShortcut(icon = Icons.Default.LocationOn, label = "位置") {
                                messages.add(
                                    MessageItem(
                                        id = System.currentTimeMillis().toString(),
                                        sender = "我",
                                        text = "[位置]",
                                        isMe = true,
                                        time = "刚刚",
                                        type = MessageType.LOCATION,
                                        locationTitle = "我的实时位置",
                                        locationAddress = "北京市朝阳区"
                                    )
                                )
                                showMorePanel = false
                            }
                            ActionShortcut(icon = Icons.Default.Info, label = "文件") {
                                messages.add(
                                    MessageItem(
                                        id = System.currentTimeMillis().toString(),
                                        sender = "我",
                                        text = "[文件]",
                                        isMe = true,
                                        time = "刚刚",
                                        type = MessageType.FILE,
                                        fileName = "Chatly_Requirement_Doc.pdf",
                                        fileSize = "1.8 MB"
                                    )
                                )
                                showMorePanel = false
                            }
                        }
                    }
                }
            }
        },
        containerColor = ChatlyBg
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize()) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                item { Spacer(modifier = Modifier.height(4.dp)) }
                items(messages) { msg ->
                    if (msg.isSystem) {
                        SystemDateDivider(msg.text)
                    } else {
                        RoomMessageBubble(
                            msg = msg,
                            onLongClick = { activeMessageForMenu = msg },
                            onPollVote = { optionId ->
                                msg.pollOptions.find { it.id == optionId }?.let { opt ->
                                    opt.votes += 1
                                    actionToast = "投票成功: ${opt.text}"
                                }
                            }
                        )
                    }
                }
                item { Spacer(modifier = Modifier.height(8.dp)) }
            }

            // Long-press Context Sheet
            activeMessageForMenu?.let { targetMsg ->
                ModalBottomSheet(
                    onDismissRequest = { activeMessageForMenu = null },
                    containerColor = Color.White
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = 24.dp, top = 8.dp)
                    ) {
                        Text(
                            text = "消息操作 (${targetMsg.sender})",
                            fontSize = 13.sp,
                            color = ChatlyTextMuted,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp)
                        )
                        HorizontalDivider(thickness = 0.5.dp, color = Color(0x1417171F))

                        ContextMenuRow(title = "引用回复") {
                            replyingToMessage = targetMsg
                            actionToast = "已选中引用消息"
                            activeMessageForMenu = null
                        }
                        ContextMenuRow(title = "复制文本") {
                            actionToast = "文本已复制到剪贴板"
                            activeMessageForMenu = null
                        }
                        ContextMenuRow(title = "转发消息") {
                            actionToast = "已打开转发选人面板"
                            activeMessageForMenu = null
                        }
                        ContextMenuRow(title = "添加收藏") {
                            actionToast = "已存入 Chatly 收藏夹"
                            activeMessageForMenu = null
                        }
                        if (targetMsg.isMe) {
                            ContextMenuRow(title = "撤回消息", isDanger = true) {
                                targetMsg.isRevoked = true
                                actionToast = "消息已撤回"
                                activeMessageForMenu = null
                            }
                        }
                        ContextMenuRow(title = "删除消息", isDanger = true) {
                            messages.remove(targetMsg)
                            actionToast = "消息已删除"
                            activeMessageForMenu = null
                        }
                    }
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
fun SystemDateDivider(text: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = text,
            fontSize = 11.sp,
            color = ChatlyTextMuted,
            fontWeight = FontWeight.Medium
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun RoomMessageBubble(
    msg: MessageItem,
    onLongClick: () -> Unit,
    onPollVote: (Int) -> Unit = {}
) {
    if (msg.isRevoked) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = "${msg.sender} 撤回了一条消息",
                fontSize = 12.sp,
                color = ChatlyTextMuted
            )
        }
        return
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (msg.isMe) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top
    ) {
        if (!msg.isMe) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(RoundedCornerShape(squircleCornerRadius(36.dp)))
                    .background(ChatlyViolet),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = msg.sender.take(1),
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp
                )
            }
            Spacer(modifier = Modifier.width(8.dp))
        }

        Column(
            horizontalAlignment = if (msg.isMe) Alignment.End else Alignment.Start,
            modifier = Modifier.widthIn(max = 280.dp)
        ) {
            if (!msg.isMe) {
                Text(
                    text = msg.sender,
                    fontSize = 11.sp,
                    color = ChatlyTextMuted,
                    modifier = Modifier.padding(bottom = 2.dp, start = 2.dp)
                )
            }

            Surface(
                shape = RoundedCornerShape(
                    topStart = 16.dp,
                    topEnd = 16.dp,
                    bottomStart = if (msg.isMe) 16.dp else 4.dp,
                    bottomEnd = if (msg.isMe) 4.dp else 16.dp
                ),
                color = if (msg.isMe) ChatlyAction else Color.White,
                tonalElevation = if (msg.isMe) 0.dp else 1.dp,
                modifier = Modifier.combinedClickable(
                    onClick = { },
                    onLongClick = onLongClick
                )
            ) {
                Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                    if (!msg.quotedText.isNullOrEmpty()) {
                        Surface(
                            color = if (msg.isMe) Color(0x33FFFFFF) else Color(0xFFF0F0F7),
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(bottom = 6.dp)
                        ) {
                            Text(
                                text = "${msg.quotedSender ?: ""}: ${msg.quotedText}",
                                fontSize = 12.sp,
                                color = if (msg.isMe) Color(0xE6FFFFFF) else ChatlyTextMuted,
                                maxLines = 2,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                            )
                        }
                    }

                    when (msg.type) {
                        MessageType.TEXT -> {
                            Text(
                                text = msg.text,
                                color = if (msg.isMe) Color.White else ChatlyText1,
                                fontSize = 15.sp,
                                lineHeight = 22.sp
                            )
                        }
                        MessageType.IMAGE -> {
                            Box(
                                modifier = Modifier
                                    .size(width = 200.dp, height = 130.dp)
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(Color(0xFFCCC5FB)),
                                contentAlignment = Alignment.Center
                            ) {
                                Text("🖼️ 图片预览", color = ChatlyViolet, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                            }
                        }
                        MessageType.VOICE -> {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    Icons.Default.Star,
                                    contentDescription = "播放语音",
                                    tint = if (msg.isMe) Color.White else ChatlyViolet,
                                    modifier = Modifier.size(20.dp)
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(
                                    text = "${msg.voiceDurationSeconds}\"",
                                    color = if (msg.isMe) Color.White else ChatlyText1,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 15.sp
                                )
                            }
                        }
                        MessageType.LOCATION -> {
                            Column {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Default.LocationOn, contentDescription = null, tint = ChatlyViolet, modifier = Modifier.size(18.dp))
                                    Spacer(modifier = Modifier.width(4.dp))
                                    Text(text = msg.locationTitle ?: "位置共享", fontWeight = FontWeight.Bold, fontSize = 14.sp, color = ChatlyText1)
                                }
                                Text(text = msg.locationAddress ?: "", fontSize = 11.sp, color = ChatlyTextMuted)
                            }
                        }
                        MessageType.POLL -> {
                            Column {
                                Text(text = "📊 ${msg.pollQuestion ?: "投票"}", fontWeight = FontWeight.Bold, fontSize = 15.sp, color = ChatlyText1)
                                Spacer(modifier = Modifier.height(8.dp))
                                msg.pollOptions.forEach { opt ->
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(vertical = 3.dp)
                                            .clip(RoundedCornerShape(8.dp))
                                            .background(Color(0xFFF0F0F7))
                                            .clickable { onPollVote(opt.id) }
                                            .padding(horizontal = 8.dp, vertical = 6.dp),
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Text(opt.text, fontSize = 13.sp, color = ChatlyText1, modifier = Modifier.weight(1f))
                                        Text("${opt.votes}票", fontSize = 12.sp, color = ChatlyViolet, fontWeight = FontWeight.Bold)
                                    }
                                }
                            }
                        }
                        MessageType.FILE -> {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Default.Info, contentDescription = null, tint = if (msg.isMe) Color.White else ChatlyViolet, modifier = Modifier.size(28.dp))
                                Spacer(modifier = Modifier.width(10.dp))
                                Column {
                                    Text(text = msg.fileName ?: "文件", fontWeight = FontWeight.Bold, fontSize = 14.sp, color = if (msg.isMe) Color.White else ChatlyText1)
                                    Text(text = msg.fileSize ?: "", fontSize = 11.sp, color = if (msg.isMe) Color(0xE6FFFFFF) else ChatlyTextMuted)
                                }
                            }
                        }
                    }
                }
            }
        }

        if (msg.isMe) {
            Spacer(modifier = Modifier.width(8.dp))
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(RoundedCornerShape(squircleCornerRadius(36.dp)))
                    .background(Color(0xFF392E88)),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "我",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 14.sp
                )
            }
        }
    }
}

@Composable
fun ContextMenuRow(
    title: String,
    isDanger: Boolean = false,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = title,
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
            color = if (isDanger) Color(0xFFC62F42) else ChatlyText1
        )
    }
}

@Composable
fun ActionShortcut(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit = {}
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.clickable(onClick = onClick)
    ) {
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(Color.White),
            contentAlignment = Alignment.Center
        ) {
            Icon(icon, contentDescription = label, tint = ChatlyViolet, modifier = Modifier.size(22.dp))
        }
        Spacer(modifier = Modifier.height(4.dp))
        Text(text = label, fontSize = 12.sp, color = ChatlyText2)
    }
}
