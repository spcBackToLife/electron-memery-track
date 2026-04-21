import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/**
 * 用单次 ResizeObserver 量宽，避免 Recharts 每个 ResponsiveContainer 各挂一套监听。
 */
export function useChartContainerWidth(): readonly [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const lastW = useRef(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const apply = (w: number) => {
      const rounded = Math.max(0, Math.floor(w))
      if (Math.abs(rounded - lastW.current) < 2) return
      lastW.current = rounded
      setWidth(rounded)
    }

    apply(el.getBoundingClientRect().width)
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w != null) apply(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, width] as const
}
