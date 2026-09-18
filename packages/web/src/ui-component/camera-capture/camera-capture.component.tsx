"use client"

import { useEffect, useRef, useState } from "react"
import styles from "./camera-capture.module.css"

type CameraCaptureProps = {
  onCapture: (file: File) => void
  onClose: () => void
}

export const CameraCapture = ({ onCapture, onClose }: CameraCaptureProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
          audio: false,
        })

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        streamRef.current = stream

        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
      } catch (cause) {
        console.error("Camera error:", cause)
        setError(
          "Не удалось открыть камеру. Проверьте, что доступ к камере разрешён в браузере, и попробуйте снова.",
        )
      }
    }

    void startCamera()

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  const handleShutter = () => {
    const video = videoRef.current
    const container = containerRef.current
    const frame = frameRef.current

    if (!video || !container || !frame || video.videoWidth === 0) {
      return
    }

    // The video fills the container with object-fit: cover, which scales it
    // up until both dimensions cover the container and crops the overflow
    // equally from each side — map the on-screen guide frame back to native
    // video pixels through that same scale/offset so the capture matches
    // exactly what the user aligned inside the frame, not the whole camera view.
    const containerRect = container.getBoundingClientRect()
    const frameRect = frame.getBoundingClientRect()

    const coverScale = Math.max(
      containerRect.width / video.videoWidth,
      containerRect.height / video.videoHeight,
    )
    const renderedVideoWidth = video.videoWidth * coverScale
    const renderedVideoHeight = video.videoHeight * coverScale
    const offsetX = (renderedVideoWidth - containerRect.width) / 2
    const offsetY = (renderedVideoHeight - containerRect.height) / 2

    const sx = (frameRect.left - containerRect.left + offsetX) / coverScale
    const sy = (frameRect.top - containerRect.top + offsetY) / coverScale
    const sWidth = frameRect.width / coverScale
    const sHeight = frameRect.height / coverScale

    const canvas = document.createElement("canvas")
    canvas.width = Math.round(sWidth)
    canvas.height = Math.round(sHeight)

    const ctx = canvas.getContext("2d")
    if (!ctx) {
      return
    }

    ctx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height)

    canvas.toBlob((blob) => {
      if (blob) {
        onCapture(new File([blob], "camera-capture.jpg", { type: "image/jpeg" }))
      }
    }, "image/jpeg", 0.92)
  }

  if (error) {
    return (
      <div className={styles.overlay}>
        <div className={styles.errorBlock}>
          <p>{error}</p>
          <button type="button" onClick={onClose} className={styles.errorCloseButton}>
            Закрыть
          </button>
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className={styles.overlay}>
      <video ref={videoRef} className={styles.video} muted playsInline />

      <p className={styles.hint}>Совместите документ с рамкой, свет — ровный, без бликов</p>

      <div ref={frameRef} className={styles.frame} />

      <div className={styles.controls}>
        <button type="button" onClick={onClose} className={styles.closeButton} aria-label="Закрыть камеру">
          ✕
        </button>
        <button
          type="button"
          onClick={handleShutter}
          className={styles.shutterButton}
          aria-label="Сфотографировать"
        />
      </div>
    </div>
  )
}
