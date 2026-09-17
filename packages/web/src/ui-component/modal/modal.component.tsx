import type { ReactNode } from "react"
import styles from "./modal.module.css"

type ModalProps = {
  isOpen: boolean
  icon?: ReactNode
  title: string
  description?: string
  closeLabel?: string
  onClose: () => void
}

export const Modal = ({
  isOpen,
  icon = "✓",
  title,
  description,
  closeLabel = "Закрыть",
  onClose,
}: ModalProps) => {
  if (!isOpen) {
    return null
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.dialog}>
        <div className={styles.iconWrap}>{icon}</div>
        <h2 className={styles.title}>{title}</h2>
        {description && <p className={styles.description}>{description}</p>}
        <button type="button" className={styles.closeButton} onClick={onClose}>
          {closeLabel}
        </button>
      </div>
    </div>
  )
}
