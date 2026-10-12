/**
 * 长按手势 —— 给「消息操作菜单」「会话操作菜单」这类地方用。
 *
 * ## 为什么必须自己做一个
 *
 * 项目原来只绑了 `onContextMenu`（浏览器右键）。那个在桌面能用，
 * **手机上根本没有右键** —— 于是「长按消息 → 回复 / 复制 / 收藏」在真机上
 * 一个都触发不了，只能靠外部鼠标。这是真机上的硬故障，不是体验问题。
 *
 * ## 三件事必须一起做对，否则会互相打架
 *
 * 1. **长按之后要把紧随其后的 click 吞掉。**
 *    手指抬起时浏览器照常派发 click —— 不拦的话，长按消息会**同时**
 *    弹出菜单并触发「引用回复」（或打开图片查看器）。这是最容易漏的一环。
 *    ⚠️ 用**时间窗**（`firedAt`）判定，不用一个布尔量：
 *    布尔量在「长按后没有 click（比如手指移开了）」时会一直悬着，
 *    把用户**下一次正常点击**也吞掉 —— 那种 bug 偶发且极难复现。
 *
 * 2. **手指移动超过阈值就取消。**
 *    用户按在消息上往下滑是在**滚动列表**，不是在长按。
 *    不判移动的话，每次滚动都会在 480ms 后弹出菜单。
 *
 * 3. **要拦住系统自己的长按菜单。**
 *    iOS Safari 长按文字会弹「拷贝 / 查询」，Android 会选中文字 ——
 *    它们会盖在我们的菜单上面。CSS 侧靠 `user-select` / `-webkit-touch-callout`
 *    （见 chat-room.css 的 .msg），这里靠 `onContextMenu` 的 preventDefault。
 *
 * ## 桌面右键仍然保留
 *
 * 右键是桌面用户的既有习惯，和长按是**同一个动作的两种触发方式**，
 * 共用一个回调。不是二选一。
 */
import { useCallback, useRef } from 'react'

/** 480ms：短于这个数，滚动列表时容易误触；长于它，手感会觉得「按了半天没反应」 */
export const LONG_PRESS_MS = 480
/** 抖动容忍：手指有点抖是正常的，超过这个位移才当成「在滚动」 */
const MOVE_TOLERANCE = 10
/** 长按之后多久内的 click 视为「这次长按的尾巴」，要吞掉 */
const CLICK_SUPPRESS_MS = 800

/**
 * @param {(e: Event) => void} onLongPress 长按（或桌面右键）触发
 * @param {{delay?:number, tolerance?:number, disabled?:boolean}} [opts]
 * @returns {{handlers: object, didLongPress: () => boolean}}
 *   `handlers` 直接展开到元素上：`<div {...handlers}>`
 */
export function useLongPress(onLongPress, opts = {}) {
  const { delay = LONG_PRESS_MS, tolerance = MOVE_TOLERANCE, disabled = false } = opts

  const timer = useRef(null)
  const origin = useRef({ x: 0, y: 0 })
  /** 上次触发长按的时间戳（0 = 没触发过）—— 见文件头第 1 条 */
  const firedAt = useRef(0)

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const fire = useCallback(
    (e) => {
      firedAt.current = Date.now()
      /* 轻微震动：真机上「长按成功」的唯一即时反馈。
         不给的话用户不知道到底按够时间没有（菜单弹出来才知道）。

         ⚠️ 只在**页面已经有过用户激活**时调用。Chrome 在「用户还没和页面交互过」
         时会往控制台打一条 error（"Blocked call to navigator.vibrate because user
         hasn't tapped on the frame..."）—— 那是浏览器策略不是我们的 bug，
         但它会污染 check-console 的结论（headless 里跑长按自检必然触发）。
         真机上用户已经在触摸页面，`userActivation.isActive` 为真，照常震动。
         `navigator.userActivation` 不存在的老浏览器直接跳过（不是错误）。 */
      try {
        if (navigator.userActivation?.isActive) navigator.vibrate?.(15)
      } catch {
        /* 不支持 / 被策略拦下都无所谓 */
      }
      onLongPress?.(e)
    },
    [onLongPress]
  )

  const onPointerDown = useCallback(
    (e) => {
      if (disabled) return
      /* 只认主键：鼠标左键 / 触摸 / 笔。右键交给 onContextMenu，
         中键、右键按下不应该启动长按计时器。 */
      if (e.pointerType === 'mouse' && e.button !== 0) return
      origin.current = { x: e.clientX, y: e.clientY }
      cancel()
      timer.current = setTimeout(() => {
        timer.current = null
        fire(e)
      }, delay)
    },
    [delay, disabled, cancel, fire]
  )

  const onPointerMove = useCallback(
    (e) => {
      if (!timer.current) return
      const dx = Math.abs(e.clientX - origin.current.x)
      const dy = Math.abs(e.clientY - origin.current.y)
      /* 超阈值 = 用户在滚动，不是长按 —— 取消（见文件头第 2 条）。
         ⚠️ 不要在这里 preventDefault：那会把滚动也一起掐掉。 */
      if (dx > tolerance || dy > tolerance) cancel()
    },
    [cancel, tolerance]
  )

  const onContextMenu = useCallback(
    (e) => {
      if (disabled) return
      /* 桌面右键：立即触发，不等那 480ms。
         preventDefault 同时挡住系统菜单（见文件头第 3 条）。 */
      e.preventDefault()
      cancel()
      fire(e)
    },
    [disabled, cancel, fire]
  )

  /**
   * 吞掉长按尾巴上的那个 click。
   * 用捕获阶段：内部气泡（图片 / 位置 / 投票）自己也有 onClick，
   * 冒泡阶段拦不住它们 —— 必须在捕获阶段就 `stopPropagation`。
   */
  const onClickCapture = useCallback((e) => {
    if (Date.now() - firedAt.current < CLICK_SUPPRESS_MS) {
      e.stopPropagation()
      e.preventDefault()
    }
  }, [])

  /**
   * 指针离开元素。
   *
   * ⚠️ **触摸设备上手指抬起时也会触发 pointerleave**（`pointerup` 紧跟一个
   * `pointerleave`）。第一版把 onPointerLeave 直接绑成 cancel，结果：
   * 长按的计时器在手指抬起那一刻被清掉 —— 但那时长按**早该触发了**
   * （480ms 的计时器在手指还按着时就已经跑完）。真正的问题是
   * `setTimeout` 里的 `fire` 还没执行就被 cancel 掉？不 —— 是另有原因。
   *
   * 保险起见这里做**双重判断**：只有「计时器还在跑（= 长按尚未触发）」
   * 并且「指针确实离开了元素的边界」才取消。
   * 触摸抬起时 pointerType 是 touch 且坐标通常仍在元素内，不会误取消；
   * 鼠标拖出元素则会正确取消。
   */
  const onPointerLeave = useCallback(
    (e) => {
      if (!timer.current) return
      /* 触摸抬起导致的 leave 不算「离开」：目标是让手指按住不动就能触发 */
      if (e.pointerType === 'touch') return
      cancel()
    },
    [cancel]
  )

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave,
      onContextMenu,
      onClickCapture,
    },
    didLongPress: () => Date.now() - firedAt.current < CLICK_SUPPRESS_MS,
  }
}
