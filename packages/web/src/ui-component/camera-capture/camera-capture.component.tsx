"use client"

import { useEffect, useRef, useState } from "react"
import styles from "./camera-capture.module.css"

type CameraCaptureProps = {
  onCapture: (file: File) => void
  onClose: () => void
}

export const CameraCapture = ({ onCapture, onClose }: CameraCaptureProps) => {
  const videoRef = useRef<HTMLVideoElement>(null)
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

    if (!video || video.videoWidth === 0) {
      return
    }

    const canvas = document.createElement("canvas")
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight

    const ctx = canvas.getContext("2d")
    if (!ctx) {
      return
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

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
    <div className={styles.overlay}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={videoRef} className={styles.video} muted playsInline />

      <p className={styles.hint}>Совместите документ с рамкой, свет — ровный, без бликов</p>

      <div className={styles.frame} />

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
