import React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva } from 'class-variance-authority'
import { LoaderCircle } from 'lucide-react'
import { cn } from '../../lib/utils.js'

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: '!bg-primary !text-primary-foreground shadow-sm hover:brightness-110',
        destructive: '!bg-destructive !text-white shadow-sm hover:brightness-110',
        warning: '!bg-amber-400 !text-amber-950 shadow-sm hover:!bg-amber-300',
        outline: '!border !border-input !bg-transparent !text-foreground hover:!bg-accent hover:!text-accent-foreground',
        secondary: '!bg-secondary !text-secondary-foreground hover:!bg-accent',
        ghost: '!text-foreground hover:!bg-accent hover:!text-accent-foreground',
        link: '!text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 rounded-md px-3 text-xs font-semibold',
        lg: 'h-10 rounded-lg px-6 text-sm',
        icon: 'size-9',
        'icon-sm': 'size-8 rounded-md',
        'icon-lg': 'size-10 rounded-md',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export const Button = React.forwardRef(function Button({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) {
  const Component = asChild ? Slot : 'button'
  return <Component ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={asChild ? undefined : disabled || loading} aria-busy={loading || undefined} {...props}>{loading && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}{children}</Component>
})

export { buttonVariants }
