/**
 * Resize and encode uploaded raster images before sending them to the API.
 * GIFs are left intact so animated images keep their frames. If the browser
 * cannot decode/encode a format, retain the original file instead of blocking upload.
 */
const PROFILES = {
  chat: { maxEdge: 2048, quality: 0.84 },
  moment: { maxEdge: 1920, quality: 0.82 },
  cover: { maxEdge: 1920, quality: 0.82 },
  avatar: { maxEdge: 512, quality: 0.86 },
  screenshot: { maxEdge: 2048, quality: 0.84 },
}

const MAX_INLINE_SIZE = 180 * 1024

function getDimensions(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file, { imageOrientation: 'from-image' }).then((bitmap) => ({
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    }))
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => resolve({
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    })
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法读取图片'))
    }
    image.src = url
  })
}

function encodeWebp(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
}

/** Return a smaller WebP File when possible; otherwise keep the original. */
export async function compressImage(file, profile = 'chat') {
  if (!(file instanceof Blob) || !String(file.type || '').startsWith('image/')) return file
  if (file.type.toLowerCase() === 'image/gif') return file

  const options = PROFILES[profile] || PROFILES.chat
  let image
  try {
    image = await getDimensions(file)
    if (!image.width || !image.height) return file

    const scale = Math.min(1, options.maxEdge / Math.max(image.width, image.height))
    const needsResize = scale < 1
    if (!needsResize && file.size <= MAX_INLINE_SIZE) return file

    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) return file
    context.drawImage(image.source, 0, 0, width, height)

    const blob = await encodeWebp(canvas, options.quality)
    if (!blob || blob.size >= file.size) return file

    const originalName = file.name || 'image'
    const stem = originalName.replace(/\.[^.]+$/, '') || 'image'
    return new File([blob], `${stem}.webp`, { type: 'image/webp', lastModified: file.lastModified })
  } catch {
    return file
  } finally {
    image?.close()
  }
}
