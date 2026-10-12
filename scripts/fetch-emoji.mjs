/**
 * 表情素材抓取 —— Microsoft Fluent Emoji（MIT）
 *
 * 为什么写脚本而不是手工拷素材：
 *   1. 可复跑、可追溯：来源、版本、筛选规则都在代码里，换风格只改一个常量。
 *   2. 码点 → 目录名 的映射只能从仓库里每个 metadata.json 读出来（1600 个目录），
 *      手工做不了；metadata 里带的 group 又正好可以自动分组。
 *   3. 顺手把 LICENSE 落到 public/emoji/ 下，合规不靠记忆。
 *
 * 关键取舍：**不能靠「码点顺序取前 N 个」来选**。
 *   "Animals & Nature" 里码点最小的是一串冷门啮齿动物（🐀🐁🐂🐃），
 *   而 🐶🐱🐼 都排在后面 —— 按顺序截断会得到一份「全是老鼠」的动物面板。
 *   所以下面是**按常用度手写的优先清单**，截断只作为兜底。
 *
 * 产物：
 *   public/emoji/<码点>.svg   彩色 SVG，运行时 <img src="/emoji/1f600.svg">
 *   public/emoji/LICENSE.txt  上游 MIT 许可证 + 来源说明
 *   src/data/emoji.js         面板用的分组清单 + 中文名
 *
 * 用法：
 *   node scripts/fetch-emoji.mjs            # 有索引就复用，缺素材才下载
 *   node scripts/fetch-emoji.mjs --reindex  # 重新拉全量 metadata 索引
 */
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'microsoft/fluentui-emoji'
const BRANCH = 'main'
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`
const API = `https://api.github.com/repos/${REPO}`
const CLDR_ZH =
  'https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-annotations-full/annotations/zh/annotations.json'

const ROOT = 'D:/BS-chat-os'
const TMP = path.join(ROOT, '.tmp/emoji')
const OUT_DIR = path.join(ROOT, 'public/emoji')
const DATA_FILE = path.join(ROOT, 'src/data/emoji.js')

const STYLE = 'Color' // Color（彩色渐变，≈6.7KB/个）｜ Flat（扁平，≈1.3KB/个）
const CONCURRENCY = 24
const REINDEX = process.argv.includes('--reindex')

fs.mkdirSync(TMP, { recursive: true })
fs.mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      // 必须带超时：一次 370 个并发请求里只要有一条连接卡住不返回，
      // 整个 Promise.all 就永远不 settle —— 脚本会「看起来在跑」其实已经死了。
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (r.ok) return await r.text()
      if (r.status === 404) return null
      if (r.status === 429 || r.status >= 500) await sleep(400 * (i + 1))
      else return null
    } catch {
      await sleep(300 * (i + 1))
    }
  }
  return null
}

/** 有限并发：别一次开 1600 个连接 */
async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  let done = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor++
        if (i >= items.length) return
        out[i] = await fn(items[i], i)
        if (++done % 200 === 0) process.stdout.write(`    … ${done}/${items.length}\r`)
      }
    })
  )
  return out
}

/**
 * 统一码点写法：小写、去掉变体选择符 fe0f，作为素材文件名与清单 id。
 *
 * ⚠️ 分隔符有两种，都得处理 —— 上游 metadata.json 的 `unicode` 字段**用空格分隔**
 *    （`"2764 fe0f"`、`"1f468 200d 2708 fe0f"`），不是连字符。
 *    第一版只写了 `.replace(/-fe0f/g,'')`，结果 ❤️☀️✌️ 这一批带 fe0f 的
 *    全都匹配不上，370 个里少了 34 个（表现为「物品/符号组填不满」）。
 *    现在先按空格和连字符统一切段、丢掉 fe0f、再用连字符拼回去：
 *      "2764 fe0f"              → 2764
 *      "1f441 fe0f 200d 1f5e8 fe0f" → 1f441-200d-1f5e8
 */
const norm = (code) =>
  String(code)
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((p) => p && p !== 'fe0f')
    .join('-')

/* ==================== 1. 文件树 ==================== */
async function loadTree() {
  const cache = path.join(TMP, 'tree.json')
  if (fs.existsSync(cache) && !REINDEX) return JSON.parse(fs.readFileSync(cache, 'utf8'))
  console.log('▸ 拉取仓库文件树…')
  const txt = await getText(`${API}/git/trees/${BRANCH}?recursive=1`)
  if (!txt) throw new Error('拿不到文件树')
  fs.writeFileSync(cache, txt)
  return JSON.parse(txt)
}

/* ---------- 素材真实路径：从文件树解析，绝不靠猜 ----------
 *
 * 上游有两种目录布局，猜路径必翻车（第一版就翻了，370 个里挂 41 个）：
 *
 *   A 无肤色变体  assets/<目录名>/Color/<snake>_color.svg
 *       例 assets/Grinning face/Color/grinning_face_color.svg
 *   B 有肤色变体  assets/<目录名>/<肤色>/Color/<snake>_color_<肤色>.svg
 *       例 assets/Folded hands/Default/Color/folded_hands_color_default.svg
 *       这类表情**根本没有 Color/ 直属目录**，只有 Dark/Default/Light/… 六种肤色。
 *       我们取 Default —— 也就是标准的黄色款。
 *
 * 而且 `<snake>` **不是**「空格换下划线」那么简单：
 *   assets/Globe showing europe-africa/Color/globe_showing_europe-africa_color.svg  ← 连字符保留
 *   assets/On! arrow/Color/on!_arrow_color.svg                                       ← 感叹号保留
 * 所以才改成「对着 27127 条文件树做正则匹配，取第一条命中的真实路径」，
 * 名字里有什么符号都不用管。
 */
function buildAssetMap(tree) {
  const styleDir = STYLE // 'Color' | 'Flat' | 'High Contrast'
  const suffix = STYLE.toLowerCase() // 'color' | 'flat' | 'high_contrast'
  const plain = new RegExp(`^${styleDir}/[^/]+_${suffix}\\.svg$`)
  const toned = new RegExp(`^Default/${styleDir}/[^/]+_${suffix}_default\\.svg$`)

  const map = new Map()
  for (const { path: p } of tree.tree) {
    const m = /^assets\/([^/]+)\/(.+)$/.exec(p)
    if (!m) continue
    const dir = m[1]
    const rest = m[2]
    const rank = plain.test(rest) ? 0 : toned.test(rest) ? 1 : -1
    if (rank < 0) continue
    const prev = map.get(dir)
    if (!prev || rank < prev.rank) map.set(dir, { rank, path: p })
  }
  return map
}

/* ==================== 2. 全量元数据索引 ==================== */async function loadIndex(tree) {
  const cache = path.join(TMP, 'index.json')
  if (fs.existsSync(cache) && !REINDEX) return JSON.parse(fs.readFileSync(cache, 'utf8'))

  const dirs = tree.tree
    .filter((x) => /^assets\/[^/]+\/metadata\.json$/.test(x.path))
    .map((x) => x.path.replace(/^assets\//, '').replace(/\/metadata\.json$/, ''))
  console.log(`▸ 读取 ${dirs.length} 个 metadata.json 建索引…`)

  const rows = await pool(dirs, CONCURRENCY, async (dir) => {
    const txt = await getText(`${RAW}/assets/${encodeURIComponent(dir)}/metadata.json`)
    if (!txt) return null
    try {
      const m = JSON.parse(txt)
      if (!m.unicode) return null
      return {
        dir,
        code: norm(m.unicode),
        glyph: m.glyph || '',
        name: m.cldr || '',
        group: m.group || '',
        keywords: m.keywords || [],
      }
    } catch {
      return null
    }
  })

  const byCode = new Map()
  for (const r of rows.filter(Boolean)) if (!byCode.has(r.code)) byCode.set(r.code, r)
  const index = [...byCode.values()]
  fs.writeFileSync(cache, JSON.stringify(index))
  console.log(`\n   索引 ${index.length} 条 → ${cache}`)
  return index
}

/* ==================== 3. 中文名（CLDR zh 注释，一次请求） ==================== */
async function loadZhNames() {
  const cache = path.join(TMP, 'zh.json')
  if (!fs.existsSync(cache)) {
    console.log('▸ 拉取 CLDR 中文注释…')
    const txt = await getText(CLDR_ZH)
    if (!txt) throw new Error('拿不到 CLDR 中文注释')
    fs.writeFileSync(cache, txt)
  }
  const all = JSON.parse(fs.readFileSync(cache, 'utf8')).annotations.annotations
  const map = {}
  for (const [glyph, v] of Object.entries(all)) {
    // CLDR 用「字形」做键，且可能带变体选择符；统一去掉再存
    const g = glyph.replace(/\ufe0f/g, '')
    if (!map[g]) map[g] = (v.tts && v.tts[0]) || (v.default && v.default[0]) || ''
  }
  return map
}

/* ==================== 4. 面板分组与优先清单 ====================
   列表顺序 = 常用度顺序。截断 cap 只在清单不够长时兜底补齐。 */
const TABS = [
  {
    key: 'smileys',
    title: '笑脸',
    cap: 48,
    codes: [
      '1f602', '1f600', '1f603', '1f604', '1f606', '1f601', '1f605', '1f923',
      '1f642', '1f643', '1f609', '1f60a', '1f60d', '1f970', '1f618', '1f61b',
      '1f61c', '1f92a', '1f911', '1f917', '1f92d', '1f92b', '1f914', '1f928',
      '1f611', '1f636', '1f60f', '1f612', '1f644', '1f62c', '1f62e', '1f634',
      '1f637', '1f912', '1f915', '1f922', '1f92e', '1f927', '1f975', '1f976',
      '1f480', '1f4a9', '1f62d', '1f631', '1f621', '1f92c', '1f608', '1f47f',
      '1f974', '1f641', '1f921', '1f47b', '1f47d', '1f63a', '1f63b', '1f640',
    ],
  },
  {
    key: 'gestures',
    title: '手势',
    cap: 46,
    codes: [
      '1f44d', '1f44f', '1f64c', '1f44c', '270c', '1f91e', '1f918', '1f919',
      '1f91d', '1f64f', '1f44b', '1f44a', '270a', '1f44e', '1f448', '1f449',
      '1f446', '1f447', '261d', '270b', '1f590', '1f596', '1f90c', '1f90f',
      '1f91a', '1f91b', '1f91c', '1f932', '1f450', '1f4aa', '1f9be', '1f440',
      '1f441', '1f445', '1f444', '1f443', '1f442', '1f9e0', '1f4af', '1f525',
      '1f4a5', '1f4ab', '1f4a6', '1f4a8', '1f4a4', '1f64b', '1f647', '1f645',
      '1f646', '1f937',
    ],
  },
  {
    key: 'animals',
    title: '动物',
    cap: 46,
    codes: [
      '1f436', '1f431', '1f42d', '1f439', '1f430', '1f98a', '1f43b', '1f43c',
      '1f428', '1f42f', '1f981', '1f42e', '1f437', '1f438', '1f435', '1f414',
      '1f427', '1f426', '1f424', '1f986', '1f985', '1f989', '1f987', '1f43a',
      '1f417', '1f434', '1f984', '1f41d', '1f41b', '1f98b', '1f40c', '1f41e',
      '1f41c', '1f577', '1f982', '1f422', '1f40d', '1f98e', '1f419', '1f991',
      '1f990', '1f980', '1f421', '1f420', '1f41f', '1f42c', '1f433', '1f40b',
      '1f42a', '1f406', '1f405', '1f402', '1f404', '1f40e', '1f40f', '1f411',
      '1f410', '1f413', '1f415', '1f416', '1f42b', '1f418', '1f98c',
    ],
  },
  {
    key: 'nature',
    title: '自然',
    cap: 36,
    codes: [
      '1f338', '1f490', '1f337', '1f33a', '1f33b', '1f33c', '1f339', '1f340',
      '1f331', '1f332', '1f333', '1f334', '1f335', '1f33e', '1f33f', '1f343',
      '1f342', '1f341', '1f30d', '1f30e', '1f30f', '1f310', '1f31e', '1f31d',
      '1f311', '1f315', '2b50', '1f31f', '2728', '26a1', '2600', '2601',
      '26c5', '1f324', '1f327', '1f328', '1f329', '1f32a', '1f32b', '1f300',
      '1f308', '1f30a',
    ],
  },
  {
    key: 'food',
    title: '食物',
    cap: 46,
    codes: [
      '1f34f', '1f34e', '1f34a', '1f34b', '1f34c', '1f349', '1f347', '1f353',
      '1f348', '1f352', '1f351', '1f34d', '1f965', '1f95d', '1f345', '1f346',
      '1f951', '1f955', '1f33d', '1f336', '1f952', '1f96c', '1f966', '1f9c4',
      '1f344', '1f35e', '1f950', '1f956', '1f9c0', '1f95a', '1f373', '1f95e',
      '1f953', '1f357', '1f356', '1f32d', '1f354', '1f35f', '1f355', '1f96a',
      '1f957', '1f958', '1f35d', '1f35c', '1f363', '1f364', '1f359', '1f358',
      '1f367', '1f368', '1f366', '1f369', '1f36a', '1f382', '1f370', '1f9c1',
      '1f36b', '1f36c', '1f36d', '1f36e', '1f375', '1f37a', '1f37b', '1f377',
      '1f379', '1f37e', '1f37f', '1f942', '1f943', '1f964', '1f9cb',
    ],
  },
  {
    key: 'travel',
    title: '旅行',
    cap: 38,
    codes: [
      '1f697', '1f695', '1f699', '1f68c', '1f68e', '1f693', '1f691', '1f692',
      '1f690', '1f69a', '1f69b', '1f69c', '1f6b2', '1f6f5', '1f6f4', '1f6f9',
      '2708', '1f680', '1f6f8', '1f681', '1f6a2', '26f5', '1f6a4', '1f3d4',
      '26f0', '1f30b', '1f5fb', '1f3e0', '1f3e1', '1f3e2', '1f3e5', '1f3e6',
      '1f3e8', '1f3ea', '1f3eb', '1f3ed', '1f5fc', '1f5fd', '26e9', '26f2',
      '26fa', '1f3a1', '1f3a2', '1f3a0', '1f301', '1f303', '1f309', '1f30c',
      '1f3d5', '1f3d6', '1f3dd', '1f306', '1f307', '1f5fe',
    ],
  },
  {
    key: 'activity',
    title: '活动',
    cap: 34,
    codes: [
      '1f389', '1f38a', '1f388', '1f381', '1f3c6', '1f947', '1f948', '1f949',
      '26bd', '1f3c0', '1f3c8', '26be', '1f3be', '1f3d0', '1f3b1', '1f3d3',
      '1f3af', '1f3ae', '1f3b2', '1f9e9', '1f3b0', '1f3b7', '1f3b8', '1f3b9',
      '1f3ba', '1f3bb', '1f3bc', '1f3a4', '1f3a7', '1f3b5', '1f3b6', '1f3ac',
      '1f386', '1f3a8', '1f3a9', '1f452', '1f45c', '1f45f', '1f460', '1f451',
      '1f48e', '1f4b0', '1f4b5', '1f4b3', '1f3ad', '1f387', '1f38b', '1f004',
    ],
  },
  {
    key: 'objects',
    title: '物品',
    cap: 44,
    codes: [
      '1f4f1', '1f4bb', '2328', '1f5a5', '1f5a8', '1f4f7', '1f3a5', '1f4fa',
      '1f4fb', '23f0', '231a', '1f50b', '1f50c', '1f4a1', '1f526', '1f4da',
      '1f4d6', '1f4dd', '270f', '1f4ce', '1f4cc', '1f4cd', '1f4cb', '1f4c5',
      '1f4c8', '1f4c9', '1f4ca', '1f5d1', '1f512', '1f513', '1f511', '1f528',
      '1f527', '1f529', '1f48a', '1f489', '1f52e', '1f4e3', '1f4e2', '1f514',
      '1f515', '1f4e8', '1f4e9', '1f4e4',
    ],
  },
  {
    key: 'symbols',
    title: '符号',
    cap: 48,
    codes: [
      '2764', '1f494', '1f495', '1f496', '1f497', '1f498', '1f499', '1f49a',
      '1f49b', '1f49c', '1f49d', '1f49e', '1f49f', '2763', '1f4a2', '1f4a3',
      '1f4ac', '1f4ad', '2757', '2753', '2755', '2754', '2b55', '2714',
      '274c', '2b06', '27a1', '2b07', '2b05', '1f519', '1f51a', '1f51b',
      '1f51c', '1f51d', '1f503', '1f504', '1f198', '1f195', '1f193', '1f197',
      '1f199', '1f192', '1f51f', '1f3c1', '1f6a9', '1f6a8', '26a0', '267b',
    ],
  },
]

/* ==================== 5. 大表情精选 ====================
   「大表情」是点一下直接发一条贴纸式大图的那一档。
   不是另下一批素材 —— 复用同一批文件，只是挑「单独发也成立」的：
   情绪明确、图形饱满、不依赖上下文。数量刻意压在 50 以内，
   否则面板里翻起来和普通表情没区别，就失去意义了。
   ⚠️ 这里只列**上面 TABS 里已经存在**的码点，否则会被静默丢掉。 */
const BIG_CODES = [
  '1f602', '1f92d', '1f923', '1f917', '1f60d', '1f618', '1f60a', '1f611',
  '1f644', '1f634', '1f62d', '1f621', '1f631', '1f922', '1f480', '1f4a9',
  '1f44d', '1f44e', '1f44f', '1f64f', '1f44c', '1f4aa', '1f91d', '1f64c',
  '1f4af', '1f525', '1f4a5', '1f44b',
  '1f436', '1f431', '1f43b', '1f428', '1f981', '1f98a', '1f42d', '1f439',
  '2764', '1f494', '1f389', '1f381', '1f386', '2728', '1f339', '1f490',
  '1f947', '1f680', '2b50',
]

/* ==================== 6. 选码 → 下载 → 生成 ==================== */
function build(index, zh, tab) {
  const byCode = new Map(index.map((e) => [e.code, e]))
  const used = new Set()
  const missing = []

  const groups = tab.map((t) => {
    const chosen = []
    const push = (code) => {
      if (used.has(code) || chosen.length >= t.cap) return
      const e = byCode.get(code)
      if (!e) {
        missing.push(`${t.title}/${code}`)
        return
      }
      used.add(code)
      // 中文名优先取 CLDR；少数（OK、keycap: 10）没有中文 tts，就退回英文原义
      chosen.push({ ...e, label: zh[e.glyph.replace(/\ufe0f/g, '')] || e.name || e.glyph || code })
    }
    t.codes.forEach(push)
    return { key: t.key, title: t.title, items: chosen }
  })

  // 大表情：按上面手写的顺序取，只保留真的被选中的 ——
  // 顺序有意义（就是面板里的展示顺序），所以不能 filter 后重排。
  const chosen = new Set(groups.flatMap((g) => g.items.map((e) => e.code)))
  const bigMissing = BIG_CODES.filter((c) => !chosen.has(c))
  const big = BIG_CODES.filter((c) => chosen.has(c))
    .map((c) => groups.flatMap((g) => g.items).find((e) => e.code === c))

  return { groups, missing, big, bigMissing }
}

async function download(groups, assetMap) {
  const want = groups.flatMap((g) => g.items)
  const todo = want.filter((e) => {
    const f = path.join(OUT_DIR, `${e.code}.svg`)
    return !(fs.existsSync(f) && fs.statSync(f).size > 200)
  })
  console.log(`\n▸ 素材：需要 ${want.length} 个，已有 ${want.length - todo.length} 个，下载 ${todo.length} 个…`)

  let failed = 0
  await pool(todo, CONCURRENCY, async (e) => {
    const hit = assetMap.get(e.dir)
    if (!hit) {
      failed++
      console.log(`   ⚠️ 树里找不到 ${STYLE} 素材：${e.code}「${e.dir}」`)
      return
    }
    const txt = await getText(`${RAW}/${hit.path.split('/').map(encodeURIComponent).join('/')}`)
    if (!txt || !txt.includes('<svg')) {
      failed++
      console.log(`   ⚠️ 下载失败：${e.code}「${e.dir}」← ${hit.path}`)
      return
    }
    fs.writeFileSync(path.join(OUT_DIR, `${e.code}.svg`), txt)
  })
  return { total: want.length, failed }
}

/**
 * 清掉不在当前清单里的 .svg。
 *
 * 手工清单是会改的（调顺序、换素材），改完之后旧码点的文件就成了没人引用的垃圾，
 * 而且 `ls public/emoji | wc -l` 会比清单多，看不出到底是多了还是少了。
 * 这里以「本次产物集合」为准做差集删除 —— 只删本目录下 .svg，绝不动别的。
 */
function prune(groups) {
  const want = new Set(groups.flatMap((g) => g.items.map((e) => `${e.code}.svg`)))
  const stale = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.svg') && !want.has(f))
  for (const f of stale) fs.unlinkSync(path.join(OUT_DIR, f))
  return stale.length
}

/* ==================== 7. 清单 + 许可证 ==================== */
const LICENSE = `Emoji artwork: Microsoft Fluent Emoji
Source : https://github.com/${REPO}
License: MIT — Copyright (c) Microsoft Corporation
         https://github.com/${REPO}/blob/${BRANCH}/LICENSE
Style  : ${STYLE}（彩色 SVG，约 6.7KB/个）
Note   : 本目录下的素材是上游文件的原样拷贝（仅重命名为 Unicode 码点），未作任何修改。
         可换肤色的表情（如「合十」「竖起大拇指」）取的是 Default 肤色款 ——
         上游这类表情没有 Color 直属目录，只有 Dark/Default/Light/… 六种肤色。
         由 scripts/fetch-emoji.mjs 生成，请勿手工编辑。
Emoji 名称来自 Unicode CLDR（中文注释），仅用于无障碍标签与搜索。
`

function writeManifest(groups, big, stats) {
  const L = []
  L.push('/**')
  L.push(' * 表情面板清单 —— 自动生成，勿手工编辑')
  L.push(' *   node scripts/fetch-emoji.mjs')
  L.push(' *')
  L.push(' * 素材：Microsoft Fluent Emoji（MIT），本地文件在 public/emoji/<码点>.svg。')
  L.push(' * 清单里只存码点、不存图片地址：渲染时 emojiUrl(code) 现拼，')
  L.push(' * 和头像的 preset:<n> 一个思路 —— 数据库 / 清单里都不出现大体积资源。')
  L.push(` * 共 ${stats.total} 个。`)
  L.push(' */')
  L.push('')
  L.push("export const EMOJI_BASE = '/emoji'")
  L.push('')
  L.push('/** 码点 → 本地素材地址 */')
  L.push('export function emojiUrl(code) {')
  L.push('  return `${EMOJI_BASE}/${code}.svg`')
  L.push('}')
  L.push('')
  L.push('/** 分组清单：key 是面板 tab，items 是按常用度排好的码点 */')
  L.push('export const EMOJI_TABS = [')
  for (const g of groups) {
    L.push('  {')
    L.push(`    key: ${JSON.stringify(g.key)},`)
    L.push(`    title: ${JSON.stringify(g.title)},`)
    L.push('    items: [')
    for (let i = 0; i < g.items.length; i += 10) {
      L.push('      ' + g.items.slice(i, i + 10).map((e) => JSON.stringify(e.code)).join(', ') + ',')
    }
    L.push('    ],')
    L.push('  },')
  }
  L.push(']')
  L.push('')
  L.push('/** 码点 → 名称（aria-label / 搜索结果里显示） */')
  L.push('export const EMOJI_NAMES = {')
  for (const g of groups) {
    const parts = []
    for (let i = 0; i < g.items.length; i += 4) {
      parts.push(g.items.slice(i, i + 4).map((e) => `${JSON.stringify(e.code)}: ${JSON.stringify(e.label)}`).join(', '))
    }
    L.push('  ' + parts.join(',\n  ') + ',')
  }
  L.push('}')
  L.push('')
  L.push('/** 全部码点 → 名称，供搜索用（面板按 tab 取） */')
  L.push('export const EMOJI_ALL = EMOJI_TABS.flatMap((t) => t.items)')
  L.push('')
  L.push('/**')
  L.push(' * 大表情精选：点一下直接发一条贴纸式大图，不进输入框。')
  L.push(' * 复用同一批素材，只挑「单独发也成立」的（情绪明确、图形饱满）。')
  L.push(' */')
  L.push('export const EMOJI_BIG = [')
  for (let i = 0; i < big.length; i += 10) {
    L.push('  ' + big.slice(i, i + 10).map((e) => JSON.stringify(e.code)).join(', ') + ',')
  }
  L.push(']')
  L.push('')
  fs.writeFileSync(DATA_FILE, L.join('\n'))
}

;(async () => {
  const tree = await loadTree()
  const assetMap = buildAssetMap(tree)
  const index = await loadIndex(tree)
  if (!index.length) throw new Error('索引为空，检查网络')
  const zh = await loadZhNames()
  console.log(`▸ 文件树解析出 ${assetMap.size} 个 ${STYLE} 素材路径`)

  const { groups, missing, big, bigMissing } = build(index, zh, TABS)
  const totalFound = groups.reduce((n, g) => n + g.items.length, 0)
  const zero = groups.filter((g) => g.items.length === 0)
  if (zero.length) throw new Error(`这些分组一个都没匹配上，码点写错了：${zero.map((g) => g.title).join(', ')}`)

  const toned = groups
    .flatMap((g) => g.items)
    .filter((e) => assetMap.get(e.dir)?.rank === 1)

  const stats = await download(groups, assetMap)
  const stale = prune(groups)
  fs.writeFileSync(path.join(OUT_DIR, 'LICENSE.txt'), LICENSE)
  writeManifest(groups, big, stats)

  console.log('\n── 结果 ──')
  for (const g of groups) console.log(`  ${g.title.padEnd(4)} ${String(g.items.length).padStart(3)} 个`)
  console.log(`  合计 ${totalFound} 个，下载失败 ${stats.failed} 个`)
  console.log(`  大表情 ${big.length} 个`)
  if (toned.length) console.log(`  其中 ${toned.length} 个取的是「Default 肤色」款（上游没有 Color 直属目录）`)
  console.log(`  已落盘 ${fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.svg')).length} 个 SVG${stale ? `（清理陈旧 ${stale} 个）` : ''}`)
  console.log(`  素材 → ${OUT_DIR}`)
  console.log(`  清单 → ${DATA_FILE}`)

  // 手写清单里对不上的码点必须报出来 —— 不报的话，分组只会静默变短，
  // 一眼看不出来，最后发现「符号组怎么这么少」时已经不知道是哪些丢了。
  if (missing.length) console.log(`\n  ⚠️ 清单里有 ${missing.length} 个码点在上游索引里不存在：\n     ${missing.join(' ')}`)
  if (bigMissing.length) console.log(`   ⚠️ BIG_CODES 里有 ${bigMissing.length} 个未被任何分组选中：\n     ${bigMissing.join(' ')}`)
  if (stats.failed) process.exit(1)
})()
