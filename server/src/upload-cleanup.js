import fs from 'node:fs/promises'
import path from 'node:path'
import { q } from './db.js'
import { UPLOAD_DIR } from './upload.js'

const UPLOAD_REFERENCE_QUERIES = [
  ['moment_media', 'url'],
  ['messages', 'file_url'],
  ['favorites', 'file_url'],
  // Feedback submission copies the screenshot URL; the original upload record is not its owner.
  ['feedbacks', 'screenshot_url'],
  ['users', 'avatar'],
  ['users', 'profile_cover'],
  ['conversations', 'avatar'],
]

/** Remove old public uploads that no application record references; keep a 24-hour recovery window. */
export async function purgeOrphanUploads({ graceMs = 24 * 60 * 60 * 1000 } = {}) {
  const cutoff = Date.now() - graceMs
  const files = await fs.readdir(UPLOAD_DIR, { withFileTypes: true })
  let removed = 0
  for (const entry of files) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue
    const fullPath = path.join(UPLOAD_DIR, entry.name)
    const stat = await fs.stat(fullPath).catch(() => null)
    if (!stat || stat.mtimeMs > cutoff) continue
    const url = `/uploads/${entry.name}`
    let referenced = false
    for (const [table, column] of UPLOAD_REFERENCE_QUERIES) {
      if (await q.get(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`, url)) {
        referenced = true
        break
      }
    }
    if (!referenced) {
      await fs.unlink(fullPath).then(() => { removed++ }).catch(() => {})
    }
  }
  return removed
}
