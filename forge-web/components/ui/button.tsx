import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Button — the foundry action primitive. Ember-filled `primary` for the one main action per
 * view; quiet `ghost`/`outline` for everything around it; `danger` for destructive ops. Motion
 * is a 150ms color transition only (respects prefers-reduced-motion via globals).
 */
const button = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors ' +
    'disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap',
  {
    variants: {
      variant: {
        // forge-700 (#c2410c) with white text = 5.18:1, clears WCAG AA (4.5:1); forge-600 as
        // text-on-orange only reaches ~3.6:1 and fails. Hover brightens to forge-600 for lift.
        primary:
          'bg-forge-700 text-white hover:bg-forge-600 dark:bg-forge-700 dark:hover:bg-forge-600',
        outline:
          'border border-anvil-300 bg-transparent text-anvil-800 hover:bg-anvil-100 ' +
          'dark:border-anvil-700 dark:text-anvil-100 dark:hover:bg-anvil-800',
        ghost:
          'bg-transparent text-anvil-700 hover:bg-anvil-100 dark:text-anvil-200 dark:hover:bg-anvil-800',
        danger:
          'border border-danger/40 bg-transparent text-danger hover:bg-danger/10',
        subtle:
          'bg-anvil-100 text-anvil-800 hover:bg-anvil-200 dark:bg-anvil-800 dark:text-anvil-100 dark:hover:bg-anvil-750',
      },
      size: {
        sm: 'h-7 px-2.5 text-dense',
        md: 'h-9 px-3.5 text-dense',
        lg: 'h-10 px-5 text-prose',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(button({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  )
})
