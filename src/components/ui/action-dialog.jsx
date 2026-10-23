import React, { useEffect, useState } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { Button } from './button.jsx'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './alert-dialog.jsx'
import { Input } from './input.jsx'

export function ActionDialog({ open, onOpenChange, title, description, requireReason = false, defaultReason = '', confirmLabel = '确认操作', tone, destructive = true, pending = false, onConfirm }) {
  const [reason, setReason] = useState(defaultReason)
  const actionTone = tone || (destructive ? 'danger' : 'neutral')
  useEffect(() => { if (open) setReason(defaultReason) }, [open, defaultReason])
  const submit = async (event) => {
    event.preventDefault()
    if (pending) return
    const result = await onConfirm(reason.trim())
    if (result !== false) onOpenChange(false)
  }
  const handleOpenChange = (nextOpen) => { if (nextOpen || !pending) onOpenChange(nextOpen) }
  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="op-action-dialog">
        <form onSubmit={submit} className="grid gap-5">
          <div className="op-action-dialog-heading">
            <span className={`op-alert-icon is-${actionTone}`}>{actionTone === 'neutral' ? <Info size={18} strokeWidth={2.2} /> : <AlertTriangle size={18} strokeWidth={2.2} />}</span>
            <AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader>
          </div>
          {requireReason && <label className="op-action-reason"><span className="op-action-reason-label">处理原因 <small>可留空</small></span><Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="填写原因，记录在操作审计中" autoFocus /></label>}
          <AlertDialogFooter className="op-action-dialog-footer">
            <AlertDialogCancel asChild><Button type="button" variant="outline" disabled={pending}>取消</Button></AlertDialogCancel>
            <Button type="submit" variant={actionTone === 'danger' ? 'destructive' : actionTone === 'warning' ? 'warning' : 'default'} loading={pending}>{pending ? '正在处理…' : confirmLabel}</Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}
