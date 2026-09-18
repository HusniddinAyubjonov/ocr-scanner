"use client"
/* eslint-disable @next/next/no-img-element */

import { useRef } from "react"
import type { PointerEvent } from "react"
import type { DocumentCorners, Point } from "./scanner.types"
import styles from "./document-corner-editor.module.css"

type CornerName = keyof DocumentCorners
type Props = { imageUrl: string; imageWidth: number; imageHeight: number; corners: DocumentCorners; disabled?: boolean; onChange: (corners: DocumentCorners) => void }
const CORNER_NAMES: CornerName[] = ["topLeft", "topRight", "bottomRight", "bottomLeft"]

export const DocumentCornerEditor = ({ imageUrl, imageWidth, imageHeight, corners, disabled = false, onChange }: Props) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const pointToPercent = (point: Point): Point => ({ x: point.x / imageWidth * 100, y: point.y / imageHeight * 100 })
  const updateCorner = (cornerName: CornerName, event: PointerEvent<HTMLButtonElement>) => {
    if (disabled || !editorRef.current) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const updateFromPointer = (clientX: number, clientY: number) => {
      const bounds = editorRef.current?.getBoundingClientRect()
      if (!bounds) return
      onChange({ ...corners, [cornerName]: {
        x: Math.max(0, Math.min(imageWidth, (clientX - bounds.left) / bounds.width * imageWidth)),
        y: Math.max(0, Math.min(imageHeight, (clientY - bounds.top) / bounds.height * imageHeight)),
      } })
    }
    updateFromPointer(event.clientX, event.clientY)
    const handleMove = (pointerEvent: globalThis.PointerEvent) => updateFromPointer(pointerEvent.clientX, pointerEvent.clientY)
    const handleEnd = () => { window.removeEventListener("pointermove", handleMove); window.removeEventListener("pointerup", handleEnd) }
    window.addEventListener("pointermove", handleMove)
    window.addEventListener("pointerup", handleEnd, { once: true })
  }
  const percentages = CORNER_NAMES.map((cornerName) => pointToPercent(corners[cornerName]))
  return <div ref={editorRef} className={styles.editor}>
    <img src={imageUrl} alt="Настройка границ документа" className={styles.image} />
    <svg className={styles.overlay} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points={percentages.map((point) => `${point.x},${point.y}`).join(" ")} className={styles.polygon} /></svg>
    {CORNER_NAMES.map((cornerName, index) => <button key={cornerName} type="button" aria-label={`Переместить угол ${index + 1}`} className={styles.handle} disabled={disabled} style={{ left: `${percentages[index].x}%`, top: `${percentages[index].y}%` }} onPointerDown={(event) => updateCorner(cornerName, event)}>{index + 1}</button>)}
  </div>
}
