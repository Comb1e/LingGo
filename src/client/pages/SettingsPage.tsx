import {useQuery, useQueryClient} from '@tanstack/react-query'
import {KeyRound, Pencil, Save, Trash2, X} from 'lucide-react'
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
  const [editingConnectionId, setEditingConnectionId] = useState('')
  const [profileName, setProfileName] = useState('')
  const [connectionId, setConnectionId] = useState('builtin-fake')
  const [modelId, setModelId] = useState('')
  const [temperature, setTemperature] = useState(0.7)
  const [stylePrompt, setStylePrompt] = useState('')
  const [editingProfileId, setEditingProfileId] = useState('')

  const resetConnectionForm = () => {
    setEditingConnectionId('')
    setProvider('openai')
    setConnectionName('OpenAI')
    setBaseUrl('')
    setApiKey('')
    setStructured(true)
  }
  const resetProfileForm = () => {
    setEditingProfileId('')
    setProfileName('')
    setModelId('')
    setTemperature(0.7)
    setStylePrompt('')
  }

  const saveConnection = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    try {
      const input = {
        name: connectionName,
        kind: provider,
        baseUrl: baseUrl || undefined,
        supportsStructuredOutput: structured,
        apiKey: apiKey || undefined,
      }
      const result = editingConnectionId
        ? await api.updateConnection(editingConnectionId, input)
        : await api.saveConnection(input)
      await queryClient.invalidateQueries({queryKey: ['connections']})
      setConnectionId(result.id)
      setSaved(t(editingConnectionId ? 'updated' : 'saved'))
      resetConnectionForm()
    } catch (caught) {
      setError(caught)
    }
  }
  const saveProfile = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    try {
      const input = {
        name: profileName,
        connectionId,
        modelId,
        temperature,
        stylePrompt: stylePrompt || undefined,
      }
      if (editingProfileId) await api.updateProfile(editingProfileId, input)
      else await api.saveProfile(input)
      await queryClient.invalidateQueries({queryKey: ['profiles']})
      setSaved(t(editingProfileId ? 'updated' : 'saved'))
      resetProfileForm()
    } catch (caught) {
      setError(caught)
    }
  }
  const editConnection = (id: string) => {
    const item = connections.data?.find((connection) => connection.id === id)
    if (!item) return
    setEditingConnectionId(item.id)
    setProvider(item.kind)
    setConnectionName(item.name)
    setBaseUrl(item.baseUrl ?? '')
    setApiKey('')
    setStructured(item.supportsStructuredOutput)
    setError(undefined)
    setSaved('')
  }
  const editProfile = (id: string) => {
    const item = profiles.data?.find((profile) => profile.id === id)
    if (!item) return
    setEditingProfileId(item.id)
    setProfileName(item.name)
    setConnectionId(item.connectionId)
    setModelId(item.modelId)
    setTemperature(item.temperature)
    setStylePrompt(item.stylePrompt ?? '')
    setError(undefined)
    setSaved('')
  }
  const deleteConnection = async (id: string) => {
    if (!window.confirm(t('deleteConnectionConfirm'))) return
    setError(undefined)
    setSaved('')
    try {
      await api.deleteConnection(id)
      await Promise.all([
        queryClient.invalidateQueries({queryKey: ['connections']}),
        queryClient.invalidateQueries({queryKey: ['profiles']}),
      ])
      if (connectionId === id) setConnectionId('builtin-fake')
      if (editingConnectionId === id) resetConnectionForm()
      const deletedProfileIds =
        profiles.data
          ?.filter((profile) => profile.connectionId === id)
          .map((profile) => profile.id) ?? []
      if (deletedProfileIds.includes(editingProfileId)) resetProfileForm()
      setSaved(t('deleted'))
    } catch (caught) {
      setError(caught)
    }
  }
  const deleteProfile = async (id: string) => {
    if (!window.confirm(t('deleteProfileConfirm'))) return
    setError(undefined)
    setSaved('')
    try {
      await api.deleteProfile(id)
      await queryClient.invalidateQueries({queryKey: ['profiles']})
      if (editingProfileId === id) resetProfileForm()
      setSaved(t('deleted'))
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
                  <div className="existing-actions">
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
                    {item.id !== 'builtin-fake' && (
                      <>
                        <Button
                          type="button"
                          className="icon-button compact-icon"
                          title={`${t('edit')} ${item.name}`}
                          aria-label={`${t('edit')} ${item.name}`}
                          onClick={() => editConnection(item.id)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          type="button"
                          className="icon-button danger-quiet compact-icon"
                          title={`${t('delete')} ${item.name}`}
                          aria-label={`${t('delete')} ${item.name}`}
                          onClick={() => void deleteConnection(item.id)}
                        >
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </div>
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
              <div className="form-actions">
                <Button className="primary">
                  <Save />
                  {t(
                    editingConnectionId ? 'updateConnection' : 'saveConnection',
                  )}
                </Button>
                {editingConnectionId && (
                  <Button type="button" onClick={resetConnectionForm}>
                    <X />
                    {t('cancel')}
                  </Button>
                )}
              </div>
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
                  <div className="existing-actions">
                    <span>{item.temperature}</span>
                    {item.id !== 'builtin-fake-profile' && (
                      <>
                        <Button
                          type="button"
                          className="icon-button compact-icon"
                          title={`${t('edit')} ${item.name}`}
                          aria-label={`${t('edit')} ${item.name}`}
                          onClick={() => editProfile(item.id)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          type="button"
                          className="icon-button danger-quiet compact-icon"
                          title={`${t('delete')} ${item.name}`}
                          aria-label={`${t('delete')} ${item.name}`}
                          onClick={() => void deleteProfile(item.id)}
                        >
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </div>
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
              <div className="form-actions">
                <Button className="primary">
                  <Save />
                  {t(editingProfileId ? 'updateProfile' : 'saveProfile')}
                </Button>
                {editingProfileId && (
                  <Button type="button" onClick={resetProfileForm}>
                    <X />
                    {t('cancel')}
                  </Button>
                )}
              </div>
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
