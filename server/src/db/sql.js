/**
 * SQL 方言翻译：**应用层继续写「SQLite 风格」的 SQL，进 PG 之前在这里翻一遍。**
 *
 * ## 为什么不把 124 个调用点改成 `$1` 风格
 *
 * 因为那等于「同一句 SQL 写两个版本」，而两份必然会漂 —— 改了一边忘了另一边，
 * 症状是「本地好、线上报 column 不存在」，且只在跑到那条路径时才出现。
 * 翻一遍的成本是一次性的，而且**只有这一处**需要保证正确。
 *
 * ## 翻译规则（只做真的用得上的，不追求通用 ORM）
 *
 * | SQLite | PostgreSQL | 为什么 |
 * | --- | --- | --- |
 * | `?` | `$1` `$2` … | 占位符风格不同；**必须跳过字符串与注释里的 `?`** |
 * | `@name` | `$n`（同名复用同一个编号） | SQLite 的**命名参数**，PG 不认这个语法（会直接语法错）。见下 |
 * | `INSERT OR IGNORE INTO` | `INSERT INTO … ON CONFLICT DO NOTHING` | 前者是 SQLite 专有 |
 * | `LIKE` / `NOT LIKE` | `ILIKE` / `NOT ILIKE` | SQLite 的 LIKE 对 ASCII **不区分大小写**，PG 的 LIKE 区分 —— 不翻的话 `file_name LIKE '%.zip'` 匹配不到 `.ZIP`，是**行为悄悄变了** |
 * | `unixepoch()` | `EXTRACT(EPOCH FROM now())::bigint` | 默认值表达式（防御性，当前 DML 里没用到） |
 *
 * ⚠️ 这里**没有**「给别名加引号」这条规则 —— 见 `restoreAliasCase()` 上面那段说明，
 * 加引号会连带把「查询体里对别名的引用」打断（`WHERE memberCount > 0`）。
 * 别名的键名修正放在**出参**上做，不动 SQL。
 *
 * ## ★ 别名大小写：PG 折叠成小写，SQLite 不折叠（本层最隐蔽的一条）
 *
 * PostgreSQL 把**未加引号的标识符折成小写**，SQLite 原样保留。
 * 于是 `SELECT m.user_id AS userId` 在 SQLite 上返回 `{ userId: 1 }`，
 * 在 PG 上返回 **`{ userid: 1 }`** —— 键名对不上，`row.userId` 就是 `undefined`。
 *
 * 这个错的**破坏力远大于「少一个字段」**：`chat.js` 的 `resolveTitle()` 里写着
 * `members.find((m) => m.user.id !== userId)`。`m.user.id` 变成 `undefined` 之后，
 * 这个条件**恒为真** → `find` 永远返回第一个成员 → 私聊会话名显示成**自己**。
 * 界面上看不出任何「报错」，只是「怎么聊着聊着变成我自己了」，
 * 而且**只在 PG 下出现**（本地 SQLite 全绿）—— 正是双驱动最该被抓住的那类不一致。
 *
 * ## 修在出参上，不修在 SQL 上 —— 为什么
 *
 * 第一版是「给混合大小写的别名补双引号」（`AS userId` → `AS "userId"`）。
 * 它**错**了，而且错得很典型：`discover.js` 里有一句
 *   `SELECT … (SELECT COUNT(*) …) AS memberCount … WHERE memberCount > 0`
 * —— 别名在**同一个查询体里被引用了一次**。别名带上引号之后，
 * 后面那个未加引号的引用被折叠成 `membercount`，两边**对不上**了：
 * `column "membercount" does not exist`。
 * 加引号**只是把折叠问题从「出参」挪到了「查询体」**，并没有消灭它。
 *
 * 所以改成：**SQL 一个字不动**，只在结果回来之后把键名按原样大小写还回去
 * （`restoreAliasCase`）。这样查询体里的引用与别名仍然是「一起被折叠」的，
 * 语义完全不变；而调用方拿到的键名和 SQLite 完全一致。

 *
 * ⚠️ `INSERT OR REPLACE` **故意不翻译** —— 它在两边的语义差别太大
 * （SQLite 是「删了再插」，PG 要显式写 `ON CONFLICT … DO UPDATE`），
 * 猜一个默认行为不如直接报错。项目里目前没有用到。
 *
 * ## 命名参数（`@viewer`）为什么必须一起处理
 *
 * `moment.js` 的 `listMoments` / `getMoment` 用的是**命名参数**：
 * `q.all(sql, { viewer, limit })`，SQL 里写 `WHERE m.user_id = @viewer`。
 * 这在 SQLite 上是原生的；到 PG 上则是「语法错误」——
 * 而且 `toPostgres` 若只认 `?`，它会**一路放行**，直到 `pool.query()` 才炸，
 * 报的是 `syntax error at or near "@"`，距离真正的原因（要翻命名参数）很远。
 *
 * 所以这里把两种风格都收敛成 `$n`：
 *   · 同一个名字出现多次 → **复用同一个编号**（PG 允许 `$1` 重复出现），
 *     这与 SQLite 命名参数「同名同一个值」的语义一致；
 *   · `values` 按**首次出现顺序**排好，调用方不用自己拼；
 *   · 两种风格**不许混用**（没法确定 values 该按哪个顺序排），混用直接报错。
 *
 * 于是 `toPostgres()` 的返回值变成 `{ text, values }` —— 两个都给调用方，
 * 而不是让调用方自己猜怎么把参数表重排。
 */

/**
 * 词法扫描一遍，把 SQL 切成「代码段」和「字面量段」，**只对代码段做替换** ——
 * 否则 `WHERE note = 'why?'` 里的问号会被当成占位符，报出「参数个数不对」这种
 * 指着别处的错。
 *
 * @param {string} sql   应用层写的 SQLite 风格 SQL
 * @param {any[]} [args] `q.*(sql, ...args)` 收上来的参数。
 *   元素只有一个是普通对象、且 SQL 里真的用了 `@name` 时，才走命名参数模式。
 * @returns {{text: string, values: any[] | undefined}}
 */
export function toPostgres(sql, args) {
  let params = 0
  let code = ''
  let out = ''
  /** 命名参数按**首次出现**的顺序（决定 values 的排列） */
  const namedOrder = []
  /** name -> $n */
  const namedIdx = new Map()
  let sawPositional = false

  const flush = () => {
    if (!code) return
    out +=
      code
        .replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, () => {
          throw new Error(
            'SQL 方言翻译：不支持 INSERT OR REPLACE（SQLite 是「删了再插」、PG 要显式写 ON CONFLICT … DO UPDATE）。请改成显式写法。',
          )
        })
        .replace(/\bLIKE\b/gi, 'ILIKE')
        .replace(/\bunixepoch\s*\(\s*\)/gi, 'EXTRACT(EPOCH FROM now())::bigint')
    code = ''
  }

  const isIdentStart = (ch) => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'
  const isIdent = (ch) => isIdentStart(ch) || (ch >= '0' && ch <= '9')

  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]

    // 行注释 -- …
    if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i)
      const end = j === -1 ? n : j
      flush()
      out += sql.slice(i, end)
      i = end
      continue
    }
    // 块注释 /* … */
    if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2)
      const end = j === -1 ? n : j + 2
      flush()
      out += sql.slice(i, end)
      i = end
      continue
    }
    // 单引号字符串（'' 是转义）与双引号标识符（"" 是转义）
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2
            continue
          }
          break
        }
        j++
      }
      const end = Math.min(j + 1, n)
      flush()
      out += sql.slice(i, end)
      i = end
      continue
    }
    // 位置参数 `?`
    if (c === '?') {
      sawPositional = true
      code += '$' + ++params
      i++
      continue
    }
    // 命名参数 `@name`
    if (c === '@' && isIdentStart(sql[i + 1] || '')) {
      let j = i + 2
      while (j < n && isIdent(sql[j])) j++
      const name = sql.slice(i + 1, j)
      let idx = namedIdx.get(name)
      if (!idx) {
        idx = ++params
        namedIdx.set(name, idx)
        namedOrder.push(name)
      }
      code += '$' + idx
      i = j
      continue
    }

    code += c
    i++
  }
  flush()

  /* INSERT OR IGNORE：先改写头部，再在**每条语句末尾**补 ON CONFLICT DO NOTHING。
     放在最后统一做，因为要按语句切 —— 简单地在整串末尾追加的话，
     多语句字符串里只有最后一句生效，前面的会从「忽略重复」静默变成「重复就报错」。 */
  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(out)) {
    out = out.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO')
    out = appendOnConflictDoNothing(out)
  }

  return { text: out, values: resolveValues(namedOrder, sawPositional, args) }
}

/* ================= 别名大小写的键名还原 ================= */

/** sql → Map(小写 → 原始大小写)。SQL 串是稳定的，解析结果缓存起来。 */
const aliasCache = new Map()

/**
 * 收集原文里所有**混合大小写**的 `AS <alias>`。
 *
 * 只收混合大小写的（`userId` / `fileUrl`：
 *   · 全小写（`n` / `m` / `name`）：PG 折叠后本来就是它，没什么可还原的；
 *   · 全大写（`GENERATED BY DEFAULT AS **IDENTITY**`）：那是关键字 / 类型名，
 *     不是别名（也因此 `CAST(x AS INTEGER)` 这种永远不会被误收）。
 *
 * 扫描时跳过注释与字符串 / 引号标识符 —— 和 `toPostgres` 用同一套词法边界。
 */
function collectAliases(sql) {
  const cached = aliasCache.get(sql)
  if (cached) return cached

  const map = new Map()
  const s = String(sql)
  const n = s.length
  let i = 0
  /* 上一个「词」是不是 AS —— 用它来判断后面那个标识符是不是别名 */
  let prevWord = ''

  while (i < n) {
    const c = s[i]

    if (c === '-' && s[i + 1] === '-') {
      const j = s.indexOf('\n', i)
      i = j === -1 ? n : j
      continue
    }
    if (c === '/' && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2)
      i = j === -1 ? n : j + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < n) {
        if (s[j] === c) {
          if (s[j + 1] === c) {
            j += 2
            continue
          }
          break
        }
        j++
      }
      i = Math.min(j + 1, n)
      prevWord = ''
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_]/.test(s[j])) j++
      const word = s.slice(i, j)
      if (prevWord.toUpperCase() === 'AS' && /[a-z]/.test(word) && /[A-Z]/.test(word)) {
        map.set(word.toLowerCase(), word)
      }
      prevWord = word
      i = j
      continue
    }
    if (!/\s/.test(c)) prevWord = c
    i++
  }

  /* 上限保护：SQL 串种类有限（全仓一百来句），真跑飞了也不至于把内存吃干净 */
  if (aliasCache.size > 2000) aliasCache.clear()
  aliasCache.set(s, map)
  return map
}

/**
 * 把 PG 返回的行**键名还原成 SQL 里写的原始大小写** —— 让两种驱动返回同样的形状。
 *
 * 为什么必须在出参上做、而不是改 SQL：见文件头「修在出参上，不修在 SQL 上」。
 * 简而言之，`discover.js` 有一句 `… AS memberCount … WHERE memberCount > 0`，
 * 给别名加引号会让查询体里的引用对不上。
 *
 * 没命中任何别名时**原样返回同一个数组**（不复制）—— 绝大多数查询走的是这条快路。
 */
export function restoreAliasCase(rows, sql) {
  if (!rows || !rows.length) return rows
  const map = collectAliases(sql)
  if (!map.size) return rows

  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row
    let hit = false
    for (const k of Object.keys(row)) {
      if (map.has(k)) {
        hit = true
        break
      }
    }
    if (!hit) return row

    const out = {}
    for (const [k, v] of Object.entries(row)) out[map.get(k) ?? k] = v
    return out
  })
}

/** 把参数收敛成 pg 要的 values 数组 */
function resolveValues(namedOrder, sawPositional, args) {
  /* 正常路径是 `q.get(sql, ...rest)` 收上来的**数组**；
     但直接 `toPostgres(sql, obj)` 这种调用也容错一下 ——
     否则会撞上「收到 undefined 个参数」这种看不出问题在哪的报错。 */
  let list = args ?? []
  if (!Array.isArray(list)) list = [list]

  if (namedOrder.length && sawPositional) {
    throw new Error(
      'SQL 方言翻译：同一句 SQL 里不能混用 `?` 与 `@name` 两种参数风格 —— 参数表没法同时表达「按位置」和「按名字」。',
    )
  }

  if (!namedOrder.length) {
    return list.length ? list : undefined
  }

  const obj = list.length === 1 ? list[0] : null
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(
      `SQL 方言翻译：SQL 里用了命名参数（@${namedOrder.join(' / @')}），` +
        `但传进来的不是**一个**对象（收到 ${list.length} 个参数）。` +
        `正确写法：q.get(sql, { viewer, limit })。`,
    )
  }
  return namedOrder.map((k) => {
    if (!(k in obj)) {
      throw new Error(`SQL 方言翻译：SQL 里用了 @${k}，但传进来的参数对象没有这个键（有：${Object.keys(obj).join(', ')}）`)
    }
    return obj[k]
  })
}

/**
 * 给每个 `INSERT INTO …` 语句末尾补 `ON CONFLICT DO NOTHING`。
 * 按语句切：`;` 只在字符串/标识符/注释之外才算分隔符。
 *
 * 每段都 `trim()` 再拼 —— 否则段首残留的空白会和 `'; '` 叠成两个空格。
 * （纯格式问题，但会让「同一句 SQL 翻译出来的字符串」在不同位置长得不一样，不好比对。）
 * ⚠️ 只有**含 INSERT OR IGNORE** 的串才会走到这里，所以 DDL 里那些
 * 带缩进的注释不会被影响。
 */
function appendOnConflictDoNothing(sql) {
  return splitStatements(sql)
    .map((st) => {
      const s = st.trim()
      if (!/^INSERT\s+INTO\b/i.test(s)) return s
      if (/\bON\s+CONFLICT\b/i.test(s)) return s // 已经有了就别再加，两个冲突子句是语法错
      return s + ' ON CONFLICT DO NOTHING'
    })
    .join('; ')
}

/** 按分号切语句，跳过字符串 / 标识符 / 注释里的分号 */
function splitStatements(sql) {
  const parts = []
  let cur = ''
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i)
      const end = j === -1 ? n : j
      cur += sql.slice(i, end)
      i = end
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2)
      const end = j === -1 ? n : j + 2
      cur += sql.slice(i, end)
      i = end
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2
            continue
          }
          break
        }
        j++
      }
      const end = Math.min(j + 1, n)
      cur += sql.slice(i, end)
      i = end
      continue
    }
    if (c === ';') {
      if (cur.trim()) parts.push(cur)
      cur = ''
      i++
      continue
    }
    cur += c
    i++
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

/** 把 `insert()` 用的 SQL 补上 `RETURNING id`（PG 拿不到 lastInsertRowid） */
export function withReturningId(sql) {
  if (/\bRETURNING\b/i.test(sql)) return sql
  return sql.replace(/;?\s*$/, '') + ' RETURNING id'
}
