import {ChevronDown, MessagesSquare} from 'lucide-react'
import {useEffect, useRef} from 'react'
import {useTranslation} from 'react-i18next'
import type {LlmMessageSet} from '../shared/types'

export function BenchmarkLlmMessageInspector({
  sets,
  loading,
  label,
}: {
  sets: LlmMessageSet[]
  loading: boolean
  label: string
}) {
  const {t} = useTranslation()
  const details = useRef<HTMLDetailsElement>(null)
  const hasPendingMessage = sets.some((set) =>
    set.messages.some((message) => message.pending),
  )

  useEffect(() => {
    if (hasPendingMessage && details.current) details.current.open = true
  }, [hasPendingMessage])

  return (
    <details
      ref={details}
      className="llm-message-inspector benchmark-llm-message-inspector"
    >
      <summary>
        <MessagesSquare size={16} aria-hidden="true" />
        <span>{t('llmMessages')}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <div className="llm-message-content">
        {loading ? (
          <p className="muted">{t('loadingMessages')}</p>
        ) : sets.length && sets.some((set) => set.messages.length) ? (
          sets.map((set) => (
            <section className="llm-message-set" key={set.color}>
              <header>
                <strong>{label}</strong>
                <span>{t(`llmContextStatus.${set.status}`)}</span>
                <span>{t(`llmContinuationMode.${set.continuationMode}`)}</span>
              </header>
              <ol>
                {set.messages.map((message, index) => (
                  <li key={`${message.role}-${index}`}>
                    <div>
                      <strong>{t(`llmMessageRole.${message.role}`)}</strong>
                      {message.pending && <span>{t('pendingMessage')}</span>}
                    </div>
                    <pre>{message.content}</pre>
                  </li>
                ))}
              </ol>
            </section>
          ))
        ) : (
          <p className="muted">{t('noLlmMessages')}</p>
        )}
      </div>
    </details>
  )
}
