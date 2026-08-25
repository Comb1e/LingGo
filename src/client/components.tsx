import type {ButtonHTMLAttributes, PropsWithChildren, ReactNode} from 'react'
import {AlertCircle, LoaderCircle} from 'lucide-react'

export function PageHeader({
  title,
  actions,
}: {
  title: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      <div className="header-actions">{actions}</div>
    </header>
  )
}

export function Button({
  children,
  className = '',
  ...props
}: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <button className={`button ${className}`} {...props}>
      {children}
    </button>
  )
}

export function ErrorBanner({error}: {error: unknown}) {
  if (!error) return null
  return (
    <div className="banner error-banner" role="alert">
      <AlertCircle />
      {error instanceof Error ? error.message : String(error)}
    </div>
  )
}

export function Loading({label = 'Loading'}: {label?: string}) {
  return (
    <div className="loading">
      <LoaderCircle className="spin" />
      <span>{label}</span>
    </div>
  )
}

export function StatusBadge({status, label}: {status: string; label: string}) {
  return (
    <span className={`status-badge status-${status}`}>
      <i />
      {label}
    </span>
  )
}
