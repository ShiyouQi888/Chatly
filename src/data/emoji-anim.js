/**
 * 动画大表情地址表 —— 由 scripts/fetch-emoji-anim.mjs 生成，不要手改。
 *
 * 只收录「有动画版」的大表情。没收录的不代表没有这个表情，
 * 而是上游没有给它做动画（多是手势类：👍👏🙏💪🤝…），前端要回退到静态 SVG。
 * 所以取动画地址**必须走 animUrl() 判空**，不能假设一定有。
 *
 * 格式是 **GIF**（不是 WebP）：ffmpeg 的 libwebp 会写出 blend+dispose=none 的帧，
 * 透明背景的表情会叠出残影；GIF 的 disposal=2 天然每帧清屏。详见脚本头。
 */

export const EMOJI_ANIM_DIR = '/emoji-anim'

export const EMOJI_ANIM = {
  '1f389': '/emoji-anim/1f389.gif',
  '1f428': '/emoji-anim/1f428.gif',
  '1f42d': '/emoji-anim/1f42d.gif',
  '1f431': '/emoji-anim/1f431.gif',
  '1f436': '/emoji-anim/1f436.gif',
  '1f439': '/emoji-anim/1f439.gif',
  '1f43b': '/emoji-anim/1f43b.gif',
  '1f480': '/emoji-anim/1f480.gif',
  '1f494': '/emoji-anim/1f494.gif',
  '1f4a9': '/emoji-anim/1f4a9.gif',
  '1f4af': '/emoji-anim/1f4af.gif',
  '1f525': '/emoji-anim/1f525.gif',
  '1f602': '/emoji-anim/1f602.gif',
  '1f60a': '/emoji-anim/1f60a.gif',
  '1f60d': '/emoji-anim/1f60d.gif',
  '1f618': '/emoji-anim/1f618.gif',
  '1f621': '/emoji-anim/1f621.gif',
  '1f62d': '/emoji-anim/1f62d.gif',
  '1f631': '/emoji-anim/1f631.gif',
  '1f634': '/emoji-anim/1f634.gif',
  '1f644': '/emoji-anim/1f644.gif',
  '1f680': '/emoji-anim/1f680.gif',
  '1f917': '/emoji-anim/1f917.gif',
  '1f922': '/emoji-anim/1f922.gif',
  '1f923': '/emoji-anim/1f923.gif',
  '1f92d': '/emoji-anim/1f92d.gif',
  '1f981': '/emoji-anim/1f981.gif',
  '1f98a': '/emoji-anim/1f98a.gif',
  '2764': '/emoji-anim/2764.gif',
  '2b50': '/emoji-anim/2b50.gif',
}

/** 取动画地址；没有动画版返回 null（调用方负责回退静态 SVG） */
export function animUrl(code) {
  return EMOJI_ANIM[code] || null
}
