/**
 * 键值存储 —— 平台适配层的第一项。
 *
 * ## 为什么要有它
 *
 * 现有代码到处直接用 `localStorage`（ChatTab、ChatRoom、MeTab、GeneralSettings、
 * EmojiPanel、SearchPanel、theme.js、client.js…）。浏览器里这没问题，
 * 但原生壳有两个坑：
 *
 * 1. **WebView 的 localStorage 可能被系统清理**，且和浏览器的存储分区不同，
 *    换壳等于换存储 —— 用户重装 App 后登录态全丢。
 * 2. **异步 vs 同步**：Capacitor Preferences 是异步 API，而现有代码
 *    在 render 里**同步**读存储（`useState(() => localStorage.getItem(...))`）。
 *    改成异步会直接打破 React 的初始化语义。
 *
 * ## 解法：内存镜像 + 异步落盘
 *
 * 对外暴露的 API 保持**完全同步**（`get`/`set`/`remove`/`keys`/`clearExcept`），
 * 底层是内存 Map；原生端在启动时把持久层读进内存，之后每次写操作
 * 同步改内存 + 异步落盘。
 *
 * 这样：
 * - 现有同步调用点一行不改逻辑，只改 import。
 * - 原生端启动时 `await hydrate()` 灌入持久数据，之后读都是同步的。
 * - Web 端 hydrate 是空操作（直接用 localStorage），零行为变化。
 *
 * ## 敏感项
 *
 * 登录 token 在原生端应该进 Keychain/Keystore 而非普通偏好存储。
 * 这里对 `chatly.token` / `chatly.admin.token` 走 `secureStorage` 分支
 * （原生端用 Capacitor 的 SecureStorage 插件，Web 端退回 localStorage）。
 */

import { isNative, capPlugin } from './env.js'

/** 需要加密存储的键（原生端走 Keychain / Keystore） */
const SECURE_KEYS = new Set(['chatly.token', 'chatly.admin.token'])

/** 内存镜像：原生端的数据真源，Web 端不使用（直接读 localStorage） */
const memory = new Map()

/** 原生端持久层（Preferences 插件），未安装时为 null */
let preferences = null

/** 原生端安全存储（SecureStorage 插件），未安装时为 null */
let secureStorage = null

/** 持久化写队列：保证 set/remove 按调用顺序落盘，不并发打架 */
let writeChain = Promise.resolve()

function ensurePlugins() {
  if (!isNative) return
  if (!preferences) preferences = capPlugin('Preferences')
  if (!secureStorage) secureStorage = capPlugin('SecureStorage')
}

/* ------------------------------------------------------------------ */
/* 原生端：内存镜像与持久层                                           */
/* ------------------------------------------------------------------ */

async function nativeGet(key) {
  ensurePlugins()
  if (SECURE_KEYS.has(key) && secureStorage) {
    try {
      const res = await secureStorage.get({ key })
      return res?.value ?? null
    } catch {
      /* 插件读失败不该让整个存储不可用 —— 退回普通偏好存储 */
    }
  }
  if (!preferences) return null
  try {
    const res = await preferences.get({ key })
    return res?.value ?? null
  } catch {
    return null
  }
}

async function nativeSet(key, value) {
  ensurePlugins()
  if (SECURE_KEYS.has(key) && secureStorage) {
    try {
      await secureStorage.set({ key, value })
      return
    } catch {
      /* 落回普通偏好存储 */
    }
  }
  if (!preferences) return
  try {
    await preferences.set({ key, value })
  } catch {
    /* 写失败只影响本次持久化，内存里的值仍然可用 */
  }
}

async function nativeRemove(key) {
  ensurePlugins()
  if (SECURE_KEYS.has(key) && secureStorage) {
    try {
      await secureStorage.remove({ key })
    } catch {
      /* noop */
    }
  }
  if (!preferences) return
  try {
    await preferences.remove({ key })
  } catch {
    /* noop */
  }
}

async function nativeKeys() {
  ensurePlugins()
  const out = []
  if (preferences) {
    try {
      const res = await preferences.keys()
      if (Array.isArray(res?.keys)) out.push(...res.keys)
    } catch {
      /* noop */
    }
  }
  if (secureStorage) {
    try {
      const res = await secureStorage.keys()
      if (Array.isArray(res?.keys)) out.push(...res.keys)
    } catch {
      /* noop */
    }
  }
  return [...new Set(out)]
}

/* ------------------------------------------------------------------ */
/* Web 端：localStorage                                               */
/* ------------------------------------------------------------------ */

/**
 * Web 端读。
 *
 * ⚠️ 隐私模式下 `localStorage` **访问即抛异常**（不是写入才抛），
 * 所以整段都要包 try —— 现有代码里已有几处是这么做的，这里保持一致。
 *
 * ⚠️ 另有一类环境**根本没有** localStorage：Node（跑自检脚本时）、
 * 以及某些 WebView 的隐私模式。此时退回内存存储 ——
 * 读写仍然自洽，只是进程结束就没了（对自检来说足够了）。
 */
function webGet(key) {
  try {
    if (typeof localStorage === 'undefined') return memory.has(key) ? memory.get(key) : null
    return localStorage.getItem(key)
  } catch {
    return memory.has(key) ? memory.get(key) : null
  }
}

function webSet(key, value) {
  try {
    if (typeof localStorage === 'undefined') {
      memory.set(key, String(value))
      return
    }
    localStorage.setItem(key, value)
  } catch {
    /* 存储不可用（隐私模式 / 配额满）时退回内存：不阻断主流程 */
    memory.set(key, String(value))
  }
}

function webRemove(key) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
  } catch {
    /* noop */
  }
  memory.delete(key)
}

function webKeys() {
  try {
    if (typeof localStorage === 'undefined') return [...memory.keys()]
    const out = []
    for (const key in localStorage) {
      if (Object.prototype.hasOwnProperty.call(localStorage, key)) out.push(key)
    }
    return out
  } catch {
    return [...memory.keys()]
  }
}

/* ------------------------------------------------------------------ */
/* 对外 API —— 同步语义                                               */
/* ------------------------------------------------------------------ */

/**
 * 读一个键。返回字符串或 null。
 *
 * @param {string} key
 * @returns {string|null}
 */
export function get(key) {
  if (!isNative) return webGet(key)
  return memory.has(key) ? memory.get(key) : null
}

/**
 * 写一个键。
 *
 * @param {string} key
 * @param {string} value
 */
export function set(key, value) {
  if (!isNative) {
    webSet(key, value)
    return
  }
  memory.set(key, String(value))
  writeChain = writeChain.then(() => nativeSet(key, String(value)))
}

/**
 * 删一个键。
 *
 * @param {string} key
 */
export function remove(key) {
  if (!isNative) {
    webRemove(key)
    return
  }
  memory.delete(key)
  writeChain = writeChain.then(() => nativeRemove(key))
}

/**
 * 列出所有键。
 *
 * @returns {string[]}
 */
export function keys() {
  if (!isNative) return webKeys()
  return [...memory.keys()]
}

/**
 * 清掉除白名单外的所有键。
 *
 * 用途：设置页「清除缓存」—— 保留登录态与各项设置，清掉其余。
 *
 * @param {string[]} keepKeys 要保留的键
 * @returns {string[]} 实际被清除的键
 */
export function clearExcept(keepKeys) {
  const keep = new Set(keepKeys)
  const removed = []
  for (const key of keys()) {
    if (keep.has(key)) continue
    remove(key)
    removed.push(key)
  }
  return removed
}

/**
 * 估算占用字节数（UTF-16 → 2 字节/字符）。
 *
 * 原生端只能估算已知的键集合 —— Preferences 没有「总大小」接口。
 *
 * @returns {number}
 */
export function estimateBytes() {
  let total = 0
  for (const key of keys()) {
    const value = get(key) || ''
    total += value.length * 2
  }
  return total
}

/**
 * 启动时把原生持久层灌进内存镜像。
 *
 * **Web 端是空操作**，所以在 `main.jsx` 里无条件调用也安全。
 * 原生端必须在渲染任何读存储的组件**之前** await 它，
 * 否则首屏读到的会是空值（表现为「登录态闪一下就没了」）。
 *
 * @returns {Promise<void>}
 */
export async function hydrate() {
  if (!isNative) return
  ensurePlugins()
  const allKeys = await nativeKeys()
  await Promise.all(
    allKeys.map(async (key) => {
      const value = await nativeGet(key)
      if (value != null) memory.set(key, value)
    })
  )
}

/**
 * 等所有待落盘的写操作完成。
 *
 * 主要给「登出」用 —— 登出要确保 token 从持久层里真的删掉了，
 * 否则壳被杀后 token 又回来了（用户以为登出了，下次打开还是登录态）。
 *
 * @returns {Promise<void>}
 */
export async function flush() {
  await writeChain
}
