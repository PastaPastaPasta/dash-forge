import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge conditional class names and dedupe conflicting Tailwind utilities.
 * The shadcn/yappr convention used by every `components/ui/` primitive.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Abbreviate an OID / hash / base58 identity id to a fixed prefix length.
 * Style guide: OIDs always mono, 7-char abbreviated, click-to-copy full.
 */
export function abbreviate(value: string, chars = 7): string {
  if (value.length <= chars) return value
  return value.slice(0, chars)
}
