import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The width the browser actually gave this box, in CSS pixels.
 *
 * Every chart here draws from data at that width instead of scaling one fixed `viewBox`. A
 * scaled viewBox shrinks the type along with the plot, and the mockups' 1240-unit boards fall
 * under legibility below about 700px. Measuring instead keeps text at a fixed px size and lets
 * only the plot compress.
 *
 * It hands back a callback ref rather than an object ref on purpose. A chart usually mounts
 * later than its panel — the panel spends a moment reading reserves first — and an effect that
 * ran on mount would find no node and never look again.
 *
 * Zero means "not measured yet", which is also the answer where `ResizeObserver` does not exist.
 * A caller draws nothing until it has a real number.
 */
export function useMeasuredWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!node) return
    setWidth(node.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const o = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // `contentRect` excludes padding, which is what the plot has to fit inside.
        const w = entry.contentRect.width
        setWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w))
      }
    })
    o.observe(node)
    observer.current = o
  }, [])

  useEffect(() => () => observer.current?.disconnect(), [])

  return [ref, width] as const
}
