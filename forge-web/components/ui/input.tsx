import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** How a disabled field looks (QW3-055): plainly read-only, inside a disabled fieldset too. Shared with raw selects. */
export const disabledField =
  'disabled:cursor-not-allowed disabled:border-anvil-200 disabled:bg-anvil-100 disabled:text-anvil-600 dark:disabled:border-anvil-800 dark:disabled:bg-anvil-900 dark:disabled:text-anvil-400'

const base =
  'w-full rounded-md border bg-white px-3 py-2 text-dense text-anvil-900 placeholder:text-anvil-500 ' +
  'border-anvil-300 transition-colors focus-visible:border-forge-400 ' +
  'dark:border-anvil-700 dark:bg-anvil-950 dark:text-anvil-100 dark:placeholder:text-anvil-400 ' +
  `${disabledField} ` +
  // Touch: 44px to tap, and 16px text (iOS Safari zooms the page into a smaller field on focus).
  'coarse:min-h-11 coarse:text-base'

/** Text input — foundry field styling with the shared focus ring. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(base, className)} {...props} />
  },
)

/** Multiline input (issue/comment bodies). Monospace optional via className. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(base, 'min-h-[96px] resize-y', className)} {...props} />
  },
)

/** A labelled field wrapper (label + optional hint + control). */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string
  hint?: string
  htmlFor?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-dense font-medium text-anvil-700 dark:text-anvil-200">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{hint}</p> : null}
    </div>
  )
}
