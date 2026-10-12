/**
 * Chatly 原型模拟数据
 * 说明：原型演示数据，全部为虚构内容，不含真实用户信息。
 */

/* ===== 头像地址（本地生成，无外链依赖） ===== */
const av = (seed, bg) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/></linearGradient></defs><rect width="160" height="160" fill="url(#g)"/><circle cx="${40 + seed * 9}" cy="${52 + seed * 5}" r="${30 + (seed % 4) * 5}" fill="rgba(255,255,255,.22)"/><circle cx="${118 - seed * 6}" cy="${124 - seed * 4}" r="${24 + (seed % 3) * 8}" fill="rgba(255,255,255,.16)"/></svg>`
  )}`

export const IMG = {
  me: av(1, ['#a99bfb', '#6d5df6']),
  linxiaoxia: av(2, ['#8fd3f4', '#5b8def']),
  chenmo: av(3, ['#f6b9c9', '#e8799b']),
  xiatian: av(4, ['#ffd08a', '#ff9a5c']),
  ajie: av(5, ['#a8e6cf', '#3fbf9a']),
  xiaoyu: av(6, ['#c7b3ff', '#8b6ff0']),
  chenyu: av(7, ['#9ad9f5', '#4a8fe0']),
  travel: av(8, ['#ffc0a8', '#f0885c']),
  group_design: av(9, ['#b3c7ff', '#6a7ff0']),
  group_moyu: av(10, ['#ffd6a8', '#f5a447']),
  official: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="20" fill="#6d5df6"/><path d="M22 30h36v6H22zm0 12h26v6H22zm0 12h18v6H22z" fill="#fff"/></svg>',
  plant: av(11, ['#bfe6a8', '#68b24a']),
  forest: av(12, ['#9fdcb8', '#3d9c6e']),
  book: av(13, ['#e0c9a6', '#b08a52']),
  photo: av(14, ['#c8d4e8', '#7b93b8']),
  music: av(15, ['#e2c2f0', '#a765d0']),
  running: av(16, ['#ffd9b3', '#f0954a']),
  tech: av(17, ['#a8dce8', '#4a9fb8']),
  nearby1: av(18, ['#ffcfd8', '#f0809c']),
  nearby2: av(19, ['#cfe0ff', '#6a8ae0']),
  nearby3: av(20, ['#d8f0c8', '#7ab84a']),
  nearby4: av(21, ['#ffe3b3', '#f0a840']),
}

/* ===== 状态 / Stories ===== */
export const STORIES = [
  { id: 's0', name: '我的状态', src: IMG.me, self: true, state: '☕ 今天需要咖啡', seen: true },
  { id: 's1', name: '夏天', src: IMG.xiatian, state: '🏖️ 周末出逃', seen: false },
  { id: 's2', name: '阿杰', src: IMG.ajie, state: '💻 勿扰工作中', seen: false },
  { id: 's3', name: '小鹿', src: IMG.xiaoyu, state: '🎧 正在听歌', seen: false },
  { id: 's4', name: '旅行团', src: IMG.travel, state: '在山里', seen: true },
]

/* ===== 会话列表 ===== */
export const CHATS = [
  {
    id: 'c1',
    name: '林小夏',
    src: IMG.linxiaoxia,
    online: true,
    preview: '周末去看海吧 🌊',
    time: '14:20',
    unread: 2,
    type: 'friend',
    pinned: true,
    label: '在线',
  },
  {
    id: 'c2',
    name: '设计部',
    src: IMG.group_design,
    preview: '李航：新方案我已经发到群里了',
    time: '12:36',
    unread: 8,
    type: 'group',
    members: 12,
    pinned: true,
    mention: true,
  },
  {
    id: 'c3',
    name: '摸鱼小分队',
    src: IMG.group_moyu,
    preview: '阿杰：哈哈哈哈太真实了',
    time: '11:08',
    unread: 0,
    type: 'group',
    members: 6,
    muted: true,
  },
  {
    id: 'c4',
    name: '陈宇',
    src: IMG.chenyu,
    preview: '晚上打游戏吗？',
    time: '昨天',
    unread: 0,
    type: 'friend',
    offline: true,
  },
  {
    id: 'c5',
    name: '旅行计划 🧳',
    src: IMG.travel,
    preview: '你：我订好了机票！',
    time: '昨天',
    unread: 0,
    type: 'group',
    members: 5,
    draft: false,
  },
  {
    id: 'c6',
    name: '文件中心',
    src: null,
    preview: '4 个文件 · 12.6 MB',
    time: '周一',
    unread: 0,
    type: 'file',
    special: 'file',
    sub: '4 个文件 · 12.6 MB',
  },
  {
    id: 'c7',
    name: '官方团队',
    src: null,
    preview: '版本更新：全新表情上线 🎉',
    time: '周一',
    unread: 0,
    type: 'system',
    special: 'official',
    sub: '版本更新：全新表情上线 🎉',
  },
  {
    id: 'c8',
    name: '陈墨',
    src: IMG.chenmo,
    preview: '草稿：那个拍摄方案我看了一下，觉得光线部分可以再……',
    time: '周日',
    unread: 0,
    type: 'friend',
    draft: true,
  },
]

/* ===== 消息流（以 c1 林小夏 为主，还原截图） ===== */
export const MESSAGES = {
  c1: [
    { id: 'm1', from: 'them', kind: 'text', text: '在忙吗？', time: '14:20' },
    { id: 'm2', from: 'me', kind: 'text', text: '刚忙完～', time: '14:21', read: true },
    { id: 'm3', from: 'them', kind: 'text', text: '晚上一起去看电影吧～\n新上映的那部，听说很好看！😄', time: '14:21' },
    { id: 'm4', from: 'me', kind: 'text', text: '不忙呀！我也想这部电影，几点去？', time: '14:23', read: true },
    { id: 'm5', from: 'them', kind: 'text', text: '我们 7 点在万象城见面怎么样？', time: '14:23' },
    { id: 'm6', from: 'them', kind: 'location', title: '万象城', addr: '广东省深圳市南山区科苑南路 2888 号', time: '14:24' },
    { id: 'm7', from: 'me', kind: 'text', text: '好呀！我到时发你定位 👍', time: '14:24', read: true },
    { id: 'm8', from: 'them', kind: 'text', text: '期待～😊', time: '14:24' },
  ],
  c2: [
    { id: 'g1', from: 'them', kind: 'text', sender: '李航', text: '新方案我已经发到群里了，大家看下' , time: '12:30'},
    { id: 'g2', from: 'them', kind: 'file', sender: '李航', name: '产品需求文档.pdf', size: '12.6 MB', time: '12:31' },
    { id: 'g3', from: 'them', kind: 'text', sender: '周颖', text: '@全体成员 下午 4 点开个短会，10 分钟就够', time: '12:35' },
    { id: 'g4', from: 'me', kind: 'text', text: '收到，我提前把配色稿整理好', time: '12:36' },
  ],
  c3: [
    { id: 'y1', from: 'them', kind: 'text', sender: '阿杰', text: '哈哈哈哈太真实了', time: '11:06' },
    { id: 'y2', from: 'them', kind: 'sticker', sender: '阿杰', emoji: '🙈', time: '11:07' },
    { id: 'y3', from: 'them', kind: 'text', sender: '小鹿', text: '老板刚走过去，我马上切回工作了', time: '11:08' },
  ],
  c4: [
    { id: 'n1', from: 'them', kind: 'text', text: '晚上打游戏吗？', time: '昨天 20:12' },
    { id: 'n2', from: 'me', kind: 'text', text: '看情况，先把手上的活干完', time: '昨天 20:20', read: true },
  ],
  c5: [
    { id: 't1', from: 'them', kind: 'text', sender: '夏天', text: '机票订了吗？我看价格在涨', time: '昨天 18:02' },
    { id: 't2', from: 'me', kind: 'text', text: '我订好了机票！', time: '昨天 18:10' },
  ],
  c6: [
    { id: 'f1', from: 'them', kind: 'file', sender: '林小夏', name: '旅行清单.xlsx', size: '240 KB', time: '周一 10:02' },
    { id: 'f2', from: 'me', kind: 'file', src: 'me', name: '海边行程.pdf', size: '1.8 MB', time: '周一 10:05' },
    { id: 'f3', from: 'them', kind: 'file', sender: '设计部', name: '品牌规范 v2.zip', size: '8.4 MB', time: '周一 14:22' },
  ],
  c7: [
    { id: 'o1', from: 'them', kind: 'notice', title: '版本更新', text: '全新表情与状态功能已上线，去试试吧 🎉', time: '周一 09:00' },
  ],
  c8: [
    { id: 'd1', from: 'them', kind: 'text', text: '那个拍摄方案我看了一下', time: '周日 16:40' },
    { id: 'd2', from: 'them', kind: 'text', text: '觉得光线部分可以再柔和一点', time: '周日 16:41' },
  ],
}

/* ===== 更多消息（静态预览用） ===== */
export const MORE_MSGS = {
  c1: [
    { id: 'p1', from: 'them', kind: 'text', text: '对了，上次说的那家咖啡店我去啦', time: '昨天 21:10' },
    { id: 'p2', from: 'them', kind: 'image', time: '昨天 21:11' },
    { id: 'p3', from: 'me', kind: 'text', text: '看着不错哎，下次一起去', time: '昨天 21:20', read: true },
  ],
}

/* ===== 我 · 静态资产 ===== */
export const ME = {
  name: '陈墨',
  id: 'chatly_1024',
  src: IMG.chenmo,
  cover: IMG.plant,
  bio: '热爱生活，也热爱远方 ✨',
  following: 128,
  followers: 236,
  posts: 18,
}

export const MY_STATUS = {
  emoji: '🌙',
  text: '深夜模式',
  expire: '还有 18 小时',
}

/* FAVORITES 已删除：收藏现在读真实后端（src/store/FavoriteStore.jsx）。
   留在这里的话，下次有人「顺手」引用它又会把假数据接回界面上 ——
   和当初删 CHANNELS / NEARBY / RECOMMEND / EVENTS / HOT_POSTS 同一个理由。 */

export const WATCH_LATER = [
  { id: 'wl1', title: '产品需求文档.pdf', type: 'PDF', time: '12.6 MB', src: IMG.official },
  { id: 'wl2', title: '城市夜跑 5km · 活动', type: '活动', time: '本周二', src: IMG.running },
]

export const FILES = [
  { id: 'fl1', title: '产品需求文档.pdf', type: 'PDF', size: '12.6 MB', from: '设计部', time: '今天 12:31' },
  { id: 'fl2', title: '旅行清单.xlsx', type: 'Excel', size: '240 KB', from: '林小夏', time: '周一 10:02' },
  { id: 'fl3', title: '品牌规范 v2.zip', type: '压缩包', size: '8.4 MB', from: '设计部', time: '周一 14:22' },
  { id: 'fl4', title: '海边行程.pdf', type: 'PDF', size: '1.8 MB', from: '我', time: '周一 10:05' },
  { id: 'fl5', title: '夜跑路线.gpx', type: '其他', size: '64 KB', from: '陈宇', time: '上周' },
]

/* ===== 通知中心 ===== */
export const NOTICES = [
  { id: 'nt1', tab: '互动', src: IMG.linxiaoxia, title: '林小夏', text: '赞了你的动态', time: '5 分钟前', unread: true },
  { id: 'nt2', tab: '互动', src: IMG.ajie, title: '阿杰', text: '评论了你的动态：这个构图太顶了', time: '32 分钟前', unread: true },
  { id: 'nt3', tab: '互动', src: IMG.xiaoyu, title: '小鹿', text: '开始关注你', time: '2 小时前', unread: false },
  { id: 'nt4', tab: '聊天', src: IMG.group_design, title: '设计部', text: '周颖：@全体成员 下午 4 点开个短会', time: '12:35', unread: true },
  { id: 'nt5', tab: '聊天', src: IMG.chenyu, title: '陈宇', text: '晚上打游戏吗？', time: '昨天', unread: false },
  { id: 'nt6', tab: '系统', src: null, title: '账号安全', text: '检测到新设备登录：MacBook Pro', time: '昨天 09:12', unread: false },
  { id: 'nt7', tab: '系统', src: null, title: 'Chatly 官方', text: '版本 1.0 更新：全新表情与状态功能', time: '周一', unread: false },
]

/* ===== 搜索热词 ===== */
export const HOT_SEARCH = ['周末去看海', '林小夏', '设计部', '摄影', '海边日落摄影局']

/* ===== 主题方案 ===== */
export const THEMES = [
  { id: 'th1', name: '极光', colors: ['#9b8cfb', '#5b6ef5'], active: true },
  { id: 'th2', name: '海盐', colors: ['#8fd3f4', '#4a8fe0'] },
  { id: 'th3', name: '暮色', colors: ['#f6b9c9', '#e8799b'] },
  { id: 'th4', name: '云朵', colors: ['#e8e8f4', '#b8b8d4'] },
  { id: 'th5', name: '午夜', colors: ['#4a4a6a', '#1f1f33'] },
]

/* ===== 设备 ===== */
export const DEVICES = [
  { id: 'dv1', name: 'iPhone 16 Pro', meta: '当前设备 · 深圳', now: true },
  { id: 'dv2', name: 'MacBook Pro', meta: '2 小时前 · 深圳' },
  { id: 'dv3', name: 'iPad Air', meta: '3 天前 · 深圳' },
]

/* ===== 群资源 ===== */
export const GROUP_FILES = [
  { id: 'gf1', title: '产品需求文档.pdf', size: '12.6 MB', time: '今天' },
  { id: 'gf2', title: '品牌规范 v2.zip', size: '8.4 MB', time: '周一' },
]

export const GROUP_VOTES = [
  { id: 'gv1', q: '周六去哪？', options: [{ t: '海边', v: 5 }, { t: '看电影', v: 3 }, { t: '爬山', v: 4 }, { t: '吃火锅', v: 8 }], mine: 3, status: '进行中 · 还有 2 天' },
]

export const GROUP_ANNOUNCE =
  '本周五 18:00 新版设计规范评审，请各组提前 10 分钟进入会议室，材料已上传到群文件。'

export const GROUP_MEMBERS = [
  { id: 'gm1', name: '李航', src: IMG.official, role: '群主', online: true },
  { id: 'gm2', name: '周颖', src: IMG.xiaoyu, role: '管理员', online: true },
  { id: 'gm3', name: '林小夏', src: IMG.linxiaoxia, role: '成员', online: true },
  { id: 'gm4', name: '阿杰', src: IMG.ajie, role: '成员', online: false },
  { id: 'gm5', name: '我', src: IMG.chenmo, role: '成员', online: true },
]

export const GROUP_BOT = {
  name: '设计助手',
  desc: '自动同步 Figma 更新、整理会议纪要',
  on: true,
}

export const VOTE_RESULT = {
  q: '周六去哪？',
  list: [
    { t: '海边', v: 5 },
    { t: '看电影', v: 3 },
    { t: '爬山', v: 4 },
    { t: '吃火锅', v: 8 },
  ],
}

export const AI_SUMMARY = {
  title: '本次聊天总结',
  topics: ['周末看电影', '万象城见面'],
  confirmed: ['时间：本周六 19:00', '地点：万象城'],
  todos: ['我到时发送定位'],
}

export const AI_REPLIES = ['好呀，几点？', '我都有空，听你的～', '行，那我提前订票 🎬', '没问题，期待！']
