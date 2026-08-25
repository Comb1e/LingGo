import {useQuery, useQueryClient} from '@tanstack/react-query'
import {KeyRound, Save} from 'lucide-react'
import {useState, type FormEvent} from 'react'
import {useTranslation} from 'react-i18next'
import {api} from '../api'
import {Button, ErrorBanner, Loading, PageHeader} from '../components'

export function SettingsPage() {
  const {t} = useTranslation()
  const queryClient = useQueryClient()
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: api.connections,
  })
  const profiles = useQuery({queryKey: ['profiles'], queryFn: api.profiles})
  const [error, setError] = useState<unknown>()
  const [saved, setSaved] = useState('')
  const [provider, setProvider] = useState('openai')
  const [connectionName, setConnectionName] = useState('OpenAI')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [structured, setStructured] = useState(true)
  const [profileName, setProfileName] = useState('')
  const [connectionId, setConnectionId] = useState('builtin-fake')
  const [modelId, setModelId] = useState('')
  const [temperature, setTemperature] = useState(0.7)
  const [stylePrompt, setStylePrompt] = useState('')

  const saveConnection = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    try {
      const result = await api.saveConnection({
        name: connectionName,
        kind: provider,
        baseUrl: baseUrl || undefined,
        supportsStructuredOutput: structured,
        apiKey,
      })
      await queryClient.invalidateQueries({queryKey: ['connections']})
      setConnectionId(result.id)
      setApiKey('')
      setSaved(t('saved'))
    } catch (caught) {
      setError(caught)
    }
  }
  const saveProfile = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    try {
      await api.saveProfile({
        name: profileName,
        connectionId,
        modelId,
        temperature,
        stylePrompt: stylePrompt || undefined,
      })
      await queryClient.invalidateQueries({queryKey: ['profiles']})
      setSaved(t('saved'))
      setProfileName('')
      setModelId('')
    } catch (caught) {
      setError(caught)
    }
  }

  return (
    <div className="page settings-page">
      <PageHeader title={t('settings')} />
      <ErrorBanner error={error ?? connections.error ?? profiles.error} />
      {saved && <div className="banner success-banner">{saved}</div>}
      {connections.isLoading ? (
        <Loading />
      ) : (
        <div className="settings-grid">
          <section className="settings-section">
            <h2>{t('connections')}</h2>
            <div className="existing-list">
              {connections.data?.map((item) => (
                <div className="existing-row" key={item.id}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.kind}
                      {item.baseUrl ? ` · ${item.baseUrl}` : ''}
                    </small>
                  </span>
                  <span
                    className={
                      item.hasSessionKey || item.kind === 'fake'
                        ? 'key-ready'
                        : 'key-missing'
                    }
                  >
                    <KeyRound />
                    {item.hasSessionKey || item.kind === 'fake'
                      ? 'Ready'
                      : 'No key'}
                  </span>
                </div>
              ))}
            </div>
            <form onSubmit={(event) => void saveConnection(event)}>
              <label className="field">
                <span>{t('providerName')}</span>
                <input
                  required
                  value={connectionName}
                  onChange={(event) => setConnectionName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>{t('provider')}</span>
                <select
                  value={provider}
                  onChange={(event) => {
                    setProvider(event.target.value)
                    setConnectionName(
                      event.target.value === 'google'
                        ? 'Google Gemini'
                        : event.target.value[0].toUpperCase() +
                            event.target.value.slice(1),
                    )
                  }}
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="google">Google Gemini</option>
                  <option value="compatible">OpenAI-compatible</option>
                </select>
              </label>
              <label className="field">
                <span>{t('endpoint')}</span>
                <input
                  type="url"
                  required={provider === 'compatible'}
                  placeholder={endpointPlaceholder(provider)}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
                <small className="field-note">{t('endpointNotice')}</small>
              </label>
              <label className="field">
                <span>{t('apiKey')}</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={structured}
                  onChange={(event) => setStructured(event.target.checked)}
                />
                {t('structured')}
              </label>
              <p className="field-note">{t('keyNotice')}</p>
              <Button className="primary">
                <Save />
                {t('saveConnection')}
              </Button>
            </form>
          </section>
          <section className="settings-section">
            <h2>{t('profiles')}</h2>
            <div className="existing-list">
              {profiles.data?.map((item) => (
                <div className="existing-row" key={item.id}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.modelId}</small>
                  </span>
                  <span>{item.temperature}</span>
                </div>
              ))}
            </div>
            <form onSubmit={(event) => void saveProfile(event)}>
              <label className="field">
                <span>{t('profileName')}</span>
                <input
                  required
                  value={profileName}
                  onChange={(event) => setProfileName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>{t('provider')}</span>
                <select
                  value={connectionId}
                  onChange={(event) => setConnectionId(event.target.value)}
                >
                  {connections.data?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('modelId')}</span>
                <input
                  required
                  placeholder="gpt-5-mini"
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                />
              </label>
              <label className="field">
                <span>
                  {t('temperature')} · {temperature.toFixed(1)}
                </span>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature}
                  onChange={(event) =>
                    setTemperature(Number(event.target.value))
                  }
                />
              </label>
              <label className="field">
                <span>{t('stylePrompt')}</span>
                <textarea
                  rows={4}
                  value={stylePrompt}
                  onChange={(event) => setStylePrompt(event.target.value)}
                />
              </label>
              <Button className="primary">
                <Save />
                {t('saveProfile')}
              </Button>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}

function endpointPlaceholder(provider: string) {
  if (provider === 'anthropic') return 'https://api.anthropic.com/v1'
  if (provider === 'google')
    return 'https://generativelanguage.googleapis.com/v1beta'
  if (provider === 'compatible') return 'https://example.com/v1'
  return 'https://api.openai.com/v1'
}
