import React from 'react'
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'
import { cn } from '../../lib/utils.js'

export const AlertDialog = AlertDialogPrimitive.Root
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger
export const AlertDialogPortal = AlertDialogPrimitive.Portal
export const AlertDialogOverlay = React.forwardRef(function AlertDialogOverlay({ className, ...props }, ref) {
  return <AlertDialogPrimitive.Overlay ref={ref} className={cn('fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm', className)} {...props} />
})
export const AlertDialogContent = React.forwardRef(function AlertDialogContent({ className, children, ...props }, ref) {
  return <AlertDialogPortal><AlertDialogOverlay /><AlertDialogPrimitive.Content ref={ref} className={cn('fixed left-1/2 top-1/2 z-[70] grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-5 rounded-xl !border !border-border !bg-popover p-6 !text-popover-foreground shadow-2xl outline-none', className)} {...props}>{children}</AlertDialogPrimitive.Content></AlertDialogPortal>
})
export function AlertDialogHeader({ className, ...props }) { return <div className={cn('flex flex-col gap-1.5 text-left', className)} {...props} /> }
export function AlertDialogFooter({ className, ...props }) { return <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} /> }
export function AlertDialogTitle({ className, ...props }) { return <AlertDialogPrimitive.Title className={cn('text-base font-bold leading-tight tracking-tight', className)} {...props} /> }
export function AlertDialogDescription({ className, ...props }) { return <AlertDialogPrimitive.Description className={cn('text-sm leading-relaxed text-muted-foreground', className)} {...props} /> }
