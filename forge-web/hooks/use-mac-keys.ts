'use client'

import { useEffect, useState } from 'react'

/** Whether this device's shortcuts use ⌘ (macOS, iOS) rather than Ctrl; false until mounted. */
export function useMacKeys(): boolean {
  const [mac, setMac] = useState(false)
  useEffect(() => {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? ''
    setMac(/mac|iphone|ipad|ipod/i.test(platform))
  }, [])
  return mac
}
