"use client"

import { useState } from "react"
import type { ChangeEvent } from "react"
import { createWorker, PSM } from "tesseract.js"
import { Modal } from "@/ui-component/modal/modal.component"
import { extractCleanText, preprocessImage } from "./home.utils"
import styles from "./home.module.css"

const OCR_LANGUAGES = "eng+rus+tgk"

export const Home = () => {
  const [image, setImage] = useState<string | null>(null)
  const [recognizedText, setRecognizedText] = useState("")
  const [isRecognizing, setIsRecognizing] = useState(false)
  const [recognizeProgress, setRecognizeProgress] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)

  const runRecognition = async (selectedFile: File) => {
    const imageUrl = URL.createObjectURL(selectedFile)

    setImage(imageUrl)
    setRecognizedText("")
    setErrorMessage(null)
    setRecognizeProgress(0)
    setIsRecognizing(true)

    let worker: Awaited<ReturnType<typeof createWorker>> | null = null

    try {
      const processedImageUrl = await preprocessImage(selectedFile)

      worker = await createWorker(OCR_LANGUAGES, 1, {
        logger: (message) => {
          if (message.status === "recognizing text") {
            setRecognizeProgress(Math.round(message.progress * 100))
          }
        },
      })

      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO })

      const result = await worker.recognize(processedImageUrl, {}, { blocks: true })

      URL.revokeObjectURL(processedImageUrl)

      setRecognizedText(extractCleanText(result.data))
    } catch (error) {
      console.error("OCR error:", error)
      setErrorMessage(
        error instanceof Error
          ? `Не удалось распознать текст: ${error.message}`
          : "Не удалось распознать текст. Проверьте подключение к интернету и попробуйте снова.",
      )
    } finally {
      if (worker) {
        await worker.terminate()
      }
      setIsRecognizing(false)
    }
  }

  const handleImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0]

    // reset the input so selecting the same file again still fires onChange
    event.target.value = ""

    if (!selectedFile) {
      return
    }

    void runRecognition(selectedFile)
  }

  const handleRemoveImage = () => {
    setImage(null)
    setRecognizedText("")
    setErrorMessage(null)
    setRecognizeProgress(0)
  }

  const handleSubmit = () => {
    if (!recognizedText.trim()) {
      return
    }

    setImage(null)
    setRecognizedText("")
    setIsModalOpen(true)
  }

  const handleCloseModal = () => {
    setIsModalOpen(false)
  }

  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <div className={styles.header}>
          <span className={styles.badge}>OCR</span>
          <h1 className={styles.title}>Распознавание документов</h1>
          <p className={styles.subtitle}>Русский · English · Тоҷикӣ · 0–9</p>
        </div>

        {!image && (
          <label htmlFor="document" className={styles.dropzone}>
            <svg
              className={styles.dropzoneIcon}
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M12 16V4M12 4L7 9M12 4L17 9"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <p className={styles.dropzoneTitle}>Выбрать или сфотографировать документ</p>
            <p className={styles.dropzoneHint}>
              На телефоне откроется камера, на компьютере — выбор файла
            </p>
          </label>
        )}

        <input
          id="document"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleImageChange}
          className={styles.hiddenInput}
        />

        {image && (
          <div className={styles.previewBlock}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt="Document preview" className={styles.previewImage} />

            <button
              type="button"
              onClick={handleRemoveImage}
              disabled={isRecognizing}
              className={styles.removeButton}
              aria-label="Удалить документ"
            >
              ✕
            </button>
          </div>
        )}

        {isRecognizing && (
          <div className={styles.progressBlock}>
            <div className={styles.progressLabel}>
              <span>Распознаём текст</span>
              <span>{recognizeProgress}%</span>
            </div>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${recognizeProgress}%` }} />
            </div>
          </div>
        )}

        {errorMessage && <div className={styles.errorBlock}>{errorMessage}</div>}

        <div className={styles.textareaBlock}>
          <label htmlFor="recognizedText" className={styles.textareaLabel}>
            Распознанный текст
          </label>

          <textarea
            id="recognizedText"
            value={recognizedText}
            onChange={(event) => setRecognizedText(event.target.value)}
            placeholder="Здесь появится распознанный текст..."
            rows={6}
            className={styles.textarea}
          />
        </div>

        <button
          type="button"
          onClick={handleSubmit}
          disabled={!recognizedText.trim() || isRecognizing}
          className={styles.submitButton}
        >
          Отправить
        </button>
      </div>

      <Modal
        isOpen={isModalOpen}
        title="Успешно отправлено"
        description="Документ успешно отправлен."
        onClose={handleCloseModal}
      />
    </main>
  )
}
