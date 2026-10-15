import { Router } from 'express'
import { authRequired } from '../auth.js'
import { createStatus, deleteStatus, listStatuses, recordStatusView } from '../status.js'

const router = Router()
router.use(authRequired)

router.get('/', async (req, res) => {
  res.json({ statuses: await listStatuses(req.user.id) })
})

router.post('/', async (req, res) => {
  try {
    const id = await createStatus(req.user.id, req.body || {})
    res.status(201).json({ id, statuses: await listStatuses(req.user.id) })
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message })
  }
})

router.post('/:id/view', async (req, res) => {
  try {
    await recordStatusView(Number(req.params.id), req.user.id)
    res.json({ ok: true })
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    await deleteStatus(Number(req.params.id), req.user.id)
    res.json({ ok: true })
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message })
  }
})

export default router
