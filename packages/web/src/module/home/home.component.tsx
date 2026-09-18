"use client"

import { useState } from "react"
import type { ChangeEvent } from "react"
import { createWorker, PSM } from "tesseract.js"
import { Modal } from "@/ui-component/modal/modal.component"
import { extractCleanText, preprocessImage } from "./home.utils"
import { EMPTY_ID_CARD_FIELDS, extractIdCardFields, isIdCardText } from "./id-card.utils"
import type { IdCardFields } from "./id-card.utils"
import styles from "./home.module.css"

const OCR_LANGUAGES = "eng+rus+tgk"

type Slot = {
  label: string
  image: string | null
  isRecognizing: boolean
  progress: number
  error: string | null
}

const INITIAL_SLOTS: Slot[] = [
  { label: "Фото 1 (лицевая сторона)", image: null, isRecognizing: false, progress: 0, error: null },
  { label: "Фото 2 (оборотная сторона)", image: null, isRecognizing: false, progress: 0, error: null },
]

const ID_CARD_FIELD_LABELS: { key: keyof IdCardFields; label: string }[] = [
  { key: "surname", label: "Фамилия" },
  { key: "givenNames", label: "Имя" },
  { key: "fatherName", label: "Имя отца" },
  { key: "sex", label: "Пол" },
  { key: "birthDate", label: "Дата рождения" },
  { key: "birthPlace", label: "Место рождения" },
  { key: "address", label: "Адрес" },
  { key: "personalIdNumber", label: "ID номер" },
  { key: "authority", label: "Орган выдачи" },
  { key: "documentNumber", label: "Номер документа" },
  { key: "nationalIdNumber", label: "Единый национальный ID" },
  { key: "issueDate", label: "Дата выдачи" },
  { key: "expiryDate", label: "Срок действия" },
  { key: "maritalStatus", label: "Семейное положение" },
  { key: "bloodGroup", label: "Группа крови" },
]

export const Home = () => {
  const [slots, setSlots] = useState<Slot[]>(INITIAL_SLOTS)
  const [rawTexts, setRawTexts] = useState<string[]>(["", ""])
  const [recognizedText, setRecognizedText] = useState("")
  const [isIdCard, setIsIdCard] = useState(false)
  const [idCardFields, setIdCardFields] = useState<IdCardFields>(EMPTY_ID_CARD_FIELDS)
  const [showRawText, setShowRawText] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)

  const updateSlot = (index: number, patch: Partial<Slot>) => {
    setSlots((current) => current.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)))
  }

  const runRecognition = async (index: number, selectedFile: File) => {
    const imageUrl = URL.createObjectURL(selectedFile)

    updateSlot(index, { image: imageUrl, isRecognizing: true, progress: 0, error: null })

    let worker: Awaited<ReturnType<typeof createWorker>> | null = null

    try {
      const processedImageUrl = await preprocessImage(selectedFile)

      worker = await createWorker(OCR_LANGUAGES, 1, {
        logger: (message) => {
          if (message.status === "recognizing text") {
            updateSlot(index, { progress: Math.round(message.progress * 100) })
          }
        },
      })

      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO })

      const result = await worker.recognize(processedImageUrl, {}, { blocks: true })

      URL.revokeObjectURL(processedImageUrl)

      const newText = extractCleanText(result.data)

      setRecognizedText((current) => (current.trim() ? `${current}\n${newText}` : newText))

      setRawTexts((current) => {
        const next = current.map((text, i) => (i === index ? newText : text))
        const combined = next.filter(Boolean).join("\n")

        setIsIdCard(isIdCardText(combined))
        setIdCardFields(extractIdCardFields(combined))

        return next
      })
    } catch (error) {
      console.error("OCR error:", error)
      updateSlot(index, {
        error:
          error instanceof Error
            ? `Не удалось распознать текст: ${error.message}`
            : "Не удалось распознать текст. Проверьте подключение к интернету и попробуйте снова.",
      })
    } finally {
      if (worker) {
        await worker.terminate()
      }
      updateSlot(index, { isRecognizing: false })
    }
  }

  const handleImageChange = (index: number, event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0]

    // reset the input so selecting the same file again still fires onChange
    event.target.value = ""

    if (!selectedFile) {
      return
    }

    void runRecognition(index, selectedFile)
  }

  const handleRemoveImage = (index: number) => {
    updateSlot(index, { image: null, error: null, progress: 0 })
  }

  const handleIdFieldChange = (key: keyof IdCardFields, value: string) => {
    setIdCardFields((current) => ({ ...current, [key]: value }))
  }

  const isSubmittable = isIdCard
    ? Object.values(idCardFields).some((value) => value.trim())
    : Boolean(recognizedText.trim())

  const handleSubmit = () => {
    if (!isSubmittable) {
      return
    }

    setSlots(INITIAL_SLOTS)
    setRawTexts(["", ""])
    setRecognizedText("")
    setIsIdCard(false)
    setIdCardFields(EMPTY_ID_CARD_FIELDS)
    setShowRawText(false)
    setIsModalOpen(true)
  }

  const handleCloseModal = () => {
    setIsModalOpen(false)
  }

  const isRecognizing = slots.some((slot) => slot.isRecognizing)

  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <div className={styles.header}>
          <span className={styles.badge}>OCR</span>
          <h1 className={styles.title}>Распознавание документов</h1>
          <p className={styles.subtitle}>Русский · English · Тоҷикӣ · 0–9</p>
        </div>

        {slots.map((slot, index) => (
          <div key={slot.label} className={styles.slot}>
            <p className={styles.slotLabel}>{slot.label}</p>

            {!slot.image && (
              <label htmlFor={`document-${index}`} className={styles.dropzone}>
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
                  Откроется выбор: камера или файл/галерея
                </p>
              </label>
            )}

            <input
              id={`document-${index}`}
              type="file"
              accept="image/*"
              onChange={(event) => handleImageChange(index, event)}
              className={styles.hiddenInput}
            />

            {slot.image && (
              <div className={styles.previewBlock}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={slot.image} alt="Document preview" className={styles.previewImage} />

                <button
                  type="button"
                  onClick={() => handleRemoveImage(index)}
                  disabled={slot.isRecognizing}
                  className={styles.removeButton}
                  aria-label="Удалить документ"
                >
                  ✕
                </button>
              </div>
            )}

            {slot.isRecognizing && (
              <div className={styles.progressBlock}>
                <div className={styles.progressLabel}>
                  <span>Распознаём текст</span>
                  <span>{slot.progress}%</span>
                </div>
                <div className={styles.progressTrack}>
                  <div className={styles.progressFill} style={{ width: `${slot.progress}%` }} />
                </div>
              </div>
            )}

            {slot.error && <div className={styles.errorBlock}>{slot.error}</div>}
          </div>
        ))}

        {isIdCard ? (
          <>
            <div className={styles.fieldsBlock}>
              {ID_CARD_FIELD_LABELS.map(({ key, label }) => (
                <div
                  key={key}
                  className={key === "address" ? styles.fieldRowWide : styles.fieldRow}
                >
                  <label htmlFor={`id-field-${key}`} className={styles.fieldLabel}>
                    {label}
                  </label>
                  <input
                    id={`id-field-${key}`}
                    type="text"
                    value={idCardFields[key]}
                    onChange={(event) => handleIdFieldChange(key, event.target.value)}
                    placeholder="Не найдено"
                    className={styles.fieldInput}
                  />
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setShowRawText((current) => !current)}
              className={styles.toggleRawButton}
            >
              {showRawText ? "Скрыть весь распознанный текст" : "Показать весь распознанный текст"}
            </button>

            {showRawText && (
              <div className={styles.textareaBlock}>
                <textarea
                  value={recognizedText}
                  onChange={(event) => setRecognizedText(event.target.value)}
                  rows={8}
                  className={styles.textarea}
                />
              </div>
            )}
          </>
        ) : (
          <div className={styles.textareaBlock}>
            <label htmlFor="recognizedText" className={styles.textareaLabel}>
              Распознанный текст
            </label>

            <textarea
              id="recognizedText"
              value={recognizedText}
              onChange={(event) => setRecognizedText(event.target.value)}
              placeholder="Здесь появится распознанный текст..."
              rows={8}
              className={styles.textarea}
            />
          </div>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={!isSubmittable || isRecognizing}
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
