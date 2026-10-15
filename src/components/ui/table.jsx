import React from 'react'
import { cn } from '../../lib/utils.js'

export function Table({ className, ...props }) { return <div className="relative w-full overflow-auto"><table className={cn('w-full caption-bottom text-sm', className)} {...props} /></div> }
export function TableHeader({ className, ...props }) { return <thead className={cn('[&_tr]:border-b [&_tr]:border-border', className)} {...props} /> }
export function TableBody({ className, ...props }) { return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} /> }
export function TableFooter({ className, ...props }) { return <tfoot className={cn('border-t border-border bg-muted/50 font-medium [&>tr]:last:border-b-0', className)} {...props} /> }
export function TableRow({ className, ...props }) { return <tr className={cn('border-b border-border transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted', className)} {...props} /> }
export function TableHead({ className, ...props }) { return <th className={cn('h-11 px-4 text-left align-middle text-xs font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0', className)} {...props} /> }
export function TableCell({ className, ...props }) { return <td className={cn('p-4 align-middle text-sm [&:has([role=checkbox])]:pr-0', className)} {...props} /> }
export function TableCaption({ className, ...props }) { return <caption className={cn('mt-4 text-sm text-muted-foreground', className)} {...props} /> }
