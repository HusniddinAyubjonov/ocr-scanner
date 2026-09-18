"use client"
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react"
import type { ChangeEvent } from "react"
import { CameraCapture } from "@/ui-component/camera-capture/camera-capture.component"
import { Modal } from "@/ui-component/modal/modal.component"
import { DocumentCornerEditor } from "./document-corner-editor"
import {
  correctPerspective,
  createPreprocessingVariants,
  cropDocument,
  deskewImage,
  detectDocument,
  loadSourceImage,
  revokeProcessingImage,
} from "./image-processing"
import { EMPTY_ID_CARD_FIELDS } from "./id-card.utils"
import type { IdCardFields } from "./id-card.utils"
import { recognizeIdCard } from "./id-card-ocr"
import { mergeRecognizedFields } from "./id-card-recognition"
import type { IdCardFieldKey, RecognizedField } from "./id-card-recognition"
import { INITIAL_SCANNER_STATE } from "./scanner.types"
import type { ProcessingImage, ScannerState } from "./scanner.types"
import styles from "./home.module.css"

const ID_CARD_FIELD_LABELS: { key: keyof IdCardFields; label: string }[] = [
  { key: "surname", label: "Фамилия" },
  { key: "givenNames", label: "Имя" },
  { key: "fatherName", label: "Имя отца" },
  { key: "sex", label: "Пол" },
  { key: "birthDate", label: "Дата рождения" },
  { key: "birthPlace", label: "Место рождения" },
  { key: "citizenship", label: "Гражданство" },
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

type CardSide = "front" | "back"
type SideRecognition = {
  rawText: string
  mrzText: string
  mrzConfidence: number
  pageConfidence: number
  fields: Partial<Record<IdCardFieldKey, RecognizedField>>
}
const EMPTY_SIDE_RESULTS: Record<CardSide, SideRecognition | null> = {
  front: null,
  back: null,
}

const releaseImages = (state: ScannerState): void => {
  revokeProcessingImage(state.originalImage)
  revokeProcessingImage(state.detectedImage)
  revokeProcessingImage(state.croppedImage)
  revokeProcessingImage(state.correctedImage)
  state.preprocessedVariants.forEach((variant) =>
    revokeProcessingImage(variant.image),
  )
}
const errorMessage = (cause: unknown, fallback: string): string => {
  if (!(cause instanceof Error)) return fallback
  return /network|fetch|traineddata|language/i.test(cause.message)
    ? "Не удалось загрузить языковые модели OCR. Проверьте интернет-соединение."
    : cause.message || fallback
}

export const Home = () => {
  const [scannerState, setScannerState] = useState<ScannerState>(
    INITIAL_SCANNER_STATE,
  )
  const scannerStateRef = useRef(scannerState)
  const operationIdRef = useRef(0)
  const [recognizedText, setRecognizedText] = useState("")
  const [idCardFields, setIdCardFields] =
    useState<IdCardFields>(EMPTY_ID_CARD_FIELDS)
  const [fieldMetadata, setFieldMetadata] = useState<
    Partial<Record<IdCardFieldKey, RecognizedField>>
  >({})
  const [activeSide, setActiveSide] = useState<CardSide>("front")
  const [sideResults, setSideResults] =
    useState<Record<CardSide, SideRecognition | null>>(EMPTY_SIDE_RESULTS)
  const [showRawText, setShowRawText] = useState(false)
  const [isCameraOpen, setIsCameraOpen] = useState(false)
  const [isSuccessOpen, setIsSuccessOpen] = useState(false)
  const [isDebugOpen, setIsDebugOpen] = useState(false)
  const [copyLabel, setCopyLabel] = useState("Копировать")

  useEffect(() => {
    scannerStateRef.current = scannerState
  }, [scannerState])
  useEffect(() => () => releaseImages(scannerStateRef.current), [])
  const replaceState = (nextState: ScannerState) => {
    const previousState = scannerStateRef.current
    scannerStateRef.current = nextState
    setScannerState(nextState)
    releaseImages(previousState)
  }
  const clearScanner = () => {
    operationIdRef.current += 1
    replaceState(INITIAL_SCANNER_STATE)
    setRecognizedText("")
    setIdCardFields(EMPTY_ID_CARD_FIELDS)
    setFieldMetadata({})
    setSideResults(EMPTY_SIDE_RESULTS)
    setActiveSide("front")
    setShowRawText(false)
    setIsDebugOpen(false)
  }

  const resetCurrentScan = (nextSide: CardSide) => {
    operationIdRef.current += 1
    replaceState(INITIAL_SCANNER_STATE)
    setActiveSide(nextSide)
    setIsDebugOpen(false)
  }

  const selectImage = async (file: File) => {
    const operationId = operationIdRef.current + 1
    operationIdRef.current = operationId
    releaseImages(scannerStateRef.current)
    setScannerState({
      ...INITIAL_SCANNER_STATE,
      sourceFile: file,
      status: {
        stage: "loading",
        message: "Загрузка изображения",
        progress: null,
      },
    })
    try {
      const originalImage = await loadSourceImage(file)
      if (operationId !== operationIdRef.current) {
        revokeProcessingImage(originalImage)
        return
      }
      setScannerState((current) => ({
        ...current,
        originalImage,
        status: {
          stage: "detecting",
          message: "Поиск границ документа",
          progress: null,
        },
      }))
      const detection = await detectDocument(originalImage)
      if (operationId !== operationIdRef.current) {
        revokeProcessingImage(detection.preview)
        return
      }
      setScannerState((current) => ({
        ...current,
        detectedImage: detection.preview,
        documentCorners: detection.corners,
        detectionConfidence: detection.confidence,
        status: {
          stage: "reviewing",
          message:
            detection.confidence >= 0.55
              ? "Границы найдены — проверьте углы"
              : "Низкая уверенность — скорректируйте углы",
          progress: null,
        },
      }))
    } catch (cause) {
      if (operationId === operationIdRef.current)
        setScannerState((current) => ({
          ...current,
          error: errorMessage(cause, "Не удалось открыть изображение."),
          status: {
            stage: "error",
            message: "Ошибка загрузки",
            progress: null,
          },
        }))
    }
  }
  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (file) void selectImage(file)
  }

  const runPipeline = async () => {
    const { originalImage, documentCorners } = scannerStateRef.current
    if (!originalImage || !documentCorners) return
    const operationId = operationIdRef.current + 1
    operationIdRef.current = operationId
    revokeProcessingImage(scannerStateRef.current.correctedImage)
    revokeProcessingImage(scannerStateRef.current.croppedImage)
    scannerStateRef.current.preprocessedVariants.forEach((variant) =>
      revokeProcessingImage(variant.image),
    )
    setScannerState((current) => ({
      ...current,
      croppedImage: null,
      correctedImage: null,
      preprocessedVariants: [],
      ocrResult: null,
    }))
    try {
      setScannerState((current) => ({
        ...current,
        error: null,
        status: {
          stage: "correcting",
          message: "Исправление перспективы",
          progress: null,
        },
      }))
      const croppedImage = await cropDocument(originalImage, documentCorners)
      setScannerState((current) => ({ ...current, croppedImage }))
      let correctedImage: ProcessingImage = await correctPerspective(
        originalImage,
        documentCorners,
      )
      if (operationId !== operationIdRef.current) {
        revokeProcessingImage(correctedImage)
        return
      }
      setScannerState((current) => ({
        ...current,
        correctedImage,
        status: {
          stage: "deskewing",
          message: "Выравнивание строк",
          progress: null,
        },
      }))
      const deskewedImage = await deskewImage(correctedImage)
      revokeProcessingImage(correctedImage)
      correctedImage = deskewedImage
      setScannerState((current) => ({
        ...current,
        correctedImage,
        status: {
          stage: "preprocessing",
          message: "Создание вариантов изображения",
          progress: null,
        },
      }))
      const variants = await createPreprocessingVariants(correctedImage)
      if (operationId !== operationIdRef.current) {
        variants.forEach((variant) => revokeProcessingImage(variant.image))
        return
      }
      setScannerState((current) => ({
        ...current,
        preprocessedVariants: variants,
        status: {
          stage: "recognizing",
          message: "Подготовка OCR",
          progress: 0,
        },
      }))
      const ocrOutput = await recognizeIdCard({
        variants,
        shouldContinue: () => operationId === operationIdRef.current,
        onStatus: (message, progress) =>
          setScannerState((current) => ({
            ...current,
            status: { stage: "recognizing", message, progress },
          })),
      })
      if (operationId !== operationIdRef.current) return
      setScannerState((current) => ({
        ...current,
        ocrResult: ocrOutput.ocrResult,
        status: {
          stage: "cleaning",
          message: "Проверка полей и контрольных цифр MRZ",
          progress: null,
        },
      }))
      const currentSideResult: SideRecognition = {
        rawText: ocrOutput.rawText,
        mrzText: ocrOutput.mrzText,
        mrzConfidence: ocrOutput.mrzConfidence,
        pageConfidence: ocrOutput.ocrResult.confidence,
        fields: ocrOutput.fields,
      }
      const nextSideResults = {
        ...sideResults,
        [activeSide]: currentSideResult,
      }
      const mergedFields = mergeRecognizedFields(
        nextSideResults.front?.fields ?? {},
        nextSideResults.back?.fields ?? {},
      )
      setSideResults(nextSideResults)
      setFieldMetadata(mergedFields)
      setIdCardFields((current) => {
        const nextFields = { ...current }
        for (const key of Object.keys(mergedFields) as IdCardFieldKey[]) {
          const recognizedField = mergedFields[key]
          if (recognizedField) nextFields[key] = recognizedField.value
        }
        return nextFields
      })
      const combinedRawText = (["front", "back"] as CardSide[])
        .map((side) => nextSideResults[side]?.rawText)
        .filter((text): text is string => Boolean(text))
        .join("\n\n--- ОБРАТНАЯ СТОРОНА ---\n\n")
      setRecognizedText(combinedRawText)
      setScannerState((current) => ({
        ...current,
        status: { stage: "ready", message: "Готово", progress: 100 },
      }))
    } catch (cause) {
      if (operationId === operationIdRef.current)
        setScannerState((current) => ({
          ...current,
          error: errorMessage(cause, "Обработка или OCR завершились ошибкой."),
          status: {
            stage: "error",
            message: "Обработка не завершена",
            progress: null,
          },
        }))
    }
  }
  const handleCopy = async () => {
    if (!recognizedText) return
    try {
      await navigator.clipboard.writeText(recognizedText)
      setCopyLabel("Скопировано")
    } catch {
      setCopyLabel("Ошибка копирования")
    }
    window.setTimeout(() => setCopyLabel("Копировать"), 1600)
  }
  const handleSubmit = () => {
    if (Object.values(idCardFields).some((value) => value.trim())) {
      clearScanner()
      setIsSuccessOpen(true)
    }
  }
  const busyStages = [
    "loading",
    "detecting",
    "correcting",
    "deskewing",
    "preprocessing",
    "recognizing",
    "cleaning",
  ]
  const isBusy = busyStages.includes(scannerState.status.stage)
  const statusSteps = [
    ["Изображение загружено", Boolean(scannerState.originalImage)],
    ["Документ найден", Boolean(scannerState.documentCorners)],
    ["Перспектива и наклон исправлены", Boolean(scannerState.correctedImage)],
    ["Изображение обработано", scannerState.preprocessedVariants.length > 0],
    ["Текст распознан и очищен", scannerState.status.stage === "ready"],
  ] as const

  return (
    <main className={styles.main}>
      <section className={styles.card}>
        <header className={styles.header}>
          <span className={styles.badge}>DOCUMENT SCANNER + OCR</span>
          <h1 className={styles.title}>Сканирование документов</h1>
          <p className={styles.subtitle}>Русский · English · Тоҷикӣ</p>
        </header>
        <div className={styles.sideSelector}>
          {(["front", "back"] as CardSide[]).map((side) => (
            <button
              key={side}
              type="button"
              className={
                activeSide === side ? styles.sideActive : styles.sideButton
              }
              disabled={isBusy}
              onClick={() => resetCurrentScan(side)}
            >
              {side === "front" ? "Лицевая сторона" : "Обратная сторона"}
              <span>{sideResults[side] ? "✓ распознана" : "не загружена"}</span>
            </button>
          ))}
        </div>
        {!scannerState.originalImage ? (
          <div className={styles.sourceActions}>
            <label htmlFor="document-file" className={styles.dropzone}>
              <span className={styles.dropzoneIcon}>↑</span>
              <span className={styles.dropzoneTitle}>
                Выбрать фото:{" "}
                {activeSide === "front"
                  ? "лицевая сторона"
                  : "обратная сторона"}
              </span>
              <span className={styles.dropzoneHint}>
                JPG, PNG или WebP · до 20 МБ
              </span>
            </label>
            <input
              id="document-file"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFileChange}
              className={styles.hiddenInput}
            />
            <label htmlFor="mobile-camera" className={styles.secondaryButton}>
              Открыть камеру телефона
            </label>
            <input
              id="mobile-camera"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFileChange}
              className={styles.hiddenInput}
            />
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setIsCameraOpen(true)}
            >
              Камера с направляющей рамкой
            </button>
          </div>
        ) : (
          <>
            <div className={styles.statusPanel}>
              <div>
                <span className={isBusy ? styles.spinner : styles.statusIcon}>
                  {scannerState.status.stage === "error" ? "!" : "✓"}
                </span>
                <strong>{scannerState.status.message}</strong>
              </div>
              {scannerState.status.progress !== null &&
                scannerState.status.stage === "recognizing" && (
                  <div className={styles.progressTrack}>
                    <div
                      className={styles.progressFill}
                      style={{ width: `${scannerState.status.progress}%` }}
                    />
                  </div>
                )}
              <ul className={styles.steps}>
                {statusSteps.map(([label, complete]) => (
                  <li
                    key={label}
                    className={
                      complete ? styles.stepComplete : styles.stepPending
                    }
                  >
                    {complete ? "✓" : "○"} {label}
                  </li>
                ))}
              </ul>
            </div>
            {scannerState.error && (
              <div className={styles.errorBlock}>{scannerState.error}</div>
            )}
            {scannerState.documentCorners && (
              <div className={styles.editorBlock}>
                <div className={styles.sectionHeading}>
                  <h2>Границы документа</h2>
                  <span>
                    {Math.round(scannerState.detectionConfidence * 100)}%
                    уверенности
                  </span>
                </div>
                <p className={styles.helpText}>
                  Перетащите четыре точки точно на углы листа.
                </p>
                <DocumentCornerEditor
                  imageUrl={scannerState.originalImage.url}
                  imageWidth={scannerState.originalImage.width}
                  imageHeight={scannerState.originalImage.height}
                  corners={scannerState.documentCorners}
                  disabled={isBusy}
                  onChange={(documentCorners) =>
                    setScannerState((current) => ({
                      ...current,
                      documentCorners,
                    }))
                  }
                />
                <div className={styles.inlineActions}>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={isBusy}
                    onClick={() => void runPipeline()}
                  >
                    {scannerState.status.stage === "ready"
                      ? "Обработать заново"
                      : "Исправить и распознать"}
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={isBusy}
                    onClick={() => resetCurrentScan(activeSide)}
                  >
                    Другое изображение
                  </button>
                </div>
                {scannerState.status.stage === "ready" && (
                  <button
                    type="button"
                    className={styles.scanOtherSideButton}
                    onClick={() =>
                      resetCurrentScan(
                        activeSide === "front" ? "back" : "front",
                      )
                    }
                  >
                    Сканировать{" "}
                    {activeSide === "front" ? "обратную" : "лицевую"} сторону
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {scannerState.preprocessedVariants.length > 0 && (
          <div className={styles.debugBlock}>
            <button
              type="button"
              className={styles.debugToggle}
              onClick={() => setIsDebugOpen((current) => !current)}
            >
              {isDebugOpen
                ? "Скрыть этапы обработки"
                : "Показать этапы обработки"}
            </button>
            {isDebugOpen && (
              <div className={styles.debugGrid}>
                {[
                  { label: "Original", image: scannerState.originalImage },
                  {
                    label: "Detected document",
                    image: scannerState.detectedImage,
                  },
                  {
                    label: "Cropped document",
                    image: scannerState.croppedImage,
                  },
                  {
                    label: "Perspective + deskew",
                    image: scannerState.correctedImage,
                  },
                ].map(
                  ({ label, image }) =>
                    image && (
                      <figure key={label}>
                        <figcaption>{label}</figcaption>
                        <img src={image.url} alt={label} />
                      </figure>
                    ),
                )}
                {scannerState.preprocessedVariants.map((variant) => (
                  <figure
                    key={variant.id}
                    className={
                      scannerState.ocrResult?.variantId === variant.id
                        ? styles.bestVariant
                        : undefined
                    }
                  >
                    <figcaption>
                      {variant.label}
                      {scannerState.ocrResult?.variantId === variant.id
                        ? " · выбран OCR"
                        : ""}
                    </figcaption>
                    <img src={variant.image.url} alt={variant.label} />
                  </figure>
                ))}
              </div>
            )}
          </div>
        )}
        {(sideResults.front || sideResults.back) && (
          <section className={styles.structuredResult}>
            <div className={styles.sectionHeading}>
              <h2>Данные ID-карты</h2>
              <span>Пустое поле = значение не распознано надёжно</span>
            </div>
            <div className={styles.fieldsBlock}>
              {ID_CARD_FIELD_LABELS.map(({ key, label }) => {
                const metadata = fieldMetadata[key]
                return (
                  <label
                    key={key}
                    className={
                      key === "address" ? styles.fieldRowWide : styles.fieldRow
                    }
                  >
                    <span className={styles.fieldLabelRow}>
                      <span className={styles.fieldLabel}>{label}</span>
                      {metadata && (
                        <span
                          className={
                            metadata.confidence >= 70
                              ? styles.confidenceGood
                              : styles.confidenceLow
                          }
                        >
                          {metadata.confidence}% ·{" "}
                          {metadata.source === "mrz" ? "MRZ" : "layout"}
                        </span>
                      )}
                    </span>
                    <input
                      value={idCardFields[key]}
                      placeholder="Не распознано"
                      onChange={(event) => {
                        setIdCardFields((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }))
                        setFieldMetadata((current) => {
                          const nextMetadata = { ...current }
                          delete nextMetadata[key]
                          return nextMetadata
                        })
                      }}
                      className={styles.fieldInput}
                    />
                  </label>
                )
              })}
            </div>
          </section>
        )}
        {(recognizedText || scannerState.status.stage === "ready") && (
          <section className={styles.resultBlock}>
            <button
              type="button"
              className={styles.debugToggle}
              onClick={() => setShowRawText((current) => !current)}
            >
              {showRawText ? "Скрыть raw OCR" : "Показать полный raw OCR"}
            </button>
            {showRawText && (
              <>
                <textarea
                  value={recognizedText}
                  onChange={(event) => setRecognizedText(event.target.value)}
                  rows={12}
                  className={styles.textarea}
                  aria-label="Полный raw OCR-текст"
                />
                {(["front", "back"] as CardSide[]).map(
                  (side) =>
                    sideResults[side]?.mrzText && (
                      <div key={side} className={styles.mrzBlock}>
                        <strong>
                          MRZ · {side === "front" ? "лицевая" : "обратная"} ·{" "}
                          {Math.round(sideResults[side]!.mrzConfidence)}%
                        </strong>
                        <pre>{sideResults[side]!.mrzText}</pre>
                      </div>
                    ),
                )}
              </>
            )}
            <div className={styles.inlineActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => void handleCopy()}
              >
                {copyLabel}
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setRecognizedText("")}
              >
                Очистить текст
              </button>
            </div>
          </section>
        )}
        {Object.values(idCardFields).some((value) => value.trim()) && (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isBusy}
            className={styles.submitButton}
          >
            Отправить
          </button>
        )}
      </section>
      <Modal
        isOpen={isSuccessOpen}
        title="Успешно отправлено"
        description="Документ успешно обработан."
        onClose={() => setIsSuccessOpen(false)}
      />
      {isCameraOpen && (
        <CameraCapture
          onCapture={(file) => {
            setIsCameraOpen(false)
            void selectImage(file)
          }}
          onClose={() => setIsCameraOpen(false)}
        />
      )}
    </main>
  )
}
