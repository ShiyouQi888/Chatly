import React from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils.js'

const badgeVariants = cva('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-5 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary/15 text-primary',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      destructive: 'border-transparent bg-destructive/15 text-red-300',
      outline: 'border-border text-foreground',
    },
    tone: { green: 'bg-emerald-500/15 text-emerald-300', red: 'bg-red-500/15 text-red-300', blue: 'bg-blue-500/15 text-blue-300' },
  },
  defaultVariants: { variant: 'default' },
})

export function Badge({ className, variant, tone, ...props }) {
  return <span className={cn(badgeVariants({ variant, tone }), className)} {...props} />
}

export { badgeVariants }
