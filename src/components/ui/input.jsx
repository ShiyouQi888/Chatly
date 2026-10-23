import React from 'react'
import { cn } from '../../lib/utils.js'

export const Input = React.forwardRef(function Input({ className, type, ...props }, ref) {
  return <input ref={ref} data-slot="input" type={type} className={cn('flex h-9 w-full rounded-lg border border-input bg-background px-3 py-1 text-sm font-medium text-foreground shadow-sm transition-colors placeholder:font-normal placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />
})
