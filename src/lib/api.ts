const TOKEN_KEY = 'miliconfig_token'
/** Runtime override, e.g. `localStorage.miliconfig_api_base = 'https://…/api'`. */
const API_BASE_KEY = 'miliconfig_api_base'
/**
 * Where the API lives when the panel UI is hosted somewhere that does not
 * serve the worker itself (a static host such as Freebuff, a CDN, Pages…).
 * This is the panel's own Cloudflare Pages deployment — change it if you host
 * the worker somewhere else. `/api` on the current origin always wins when it
 * answers, so a worker-served panel never touches this.
 */
const PUBLIC_API_BASE = 'https://miliconfigpro.pages.dev/api'

/** Accept only a real URL or root-relative path — never a stray build value. */
function usableBase(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/')) return null
  const trimmed = raw.replace(/\/+$/, '')
  return trimmed || null
}

const explicitBase =
  usableBase(new URLSearchParams(window.location.search).get('api')) ??
  usableBase(window.localStorage.getItem(API_BASE_KEY)) ??
  usableBase(import.meta.env.VITE_API_BASE)

/**
 * API base URL — kept as a live binding so `apiUrl()` picks up the resolved
 * host. Start with the explicit/config value, `/api` as the same-origin guess.
 */
export let API_BASE = explicitBase ?? '/api'

let resolving: Promise<string> | null = null

/**
 * Resolve which host actually serves the API, once per page load.
 *
 * Explicit configuration wins. Otherwise the current origin is probed with
 * `GET /api/health`; if that is not our API (a static host answers 404, or
 * hands back the SPA's HTML) the panel's public deployment is used instead.
 * That is what lets the same bundle work whether it is served by the worker
 * itself or hosted statically with the backend somewhere else.
 */
export function resolveApiBase(): Promise<string> {
  if (explicitBase) return Promise.resolve(explicitBase)
  if (resolving) return resolving
  // Dev servers proxy nothing — the worker runs on the same origin (`/api`).
  const candidates = import.meta.env.DEV ? ['/api'] : ['/api', PUBLIC_API_BASE]
  resolving = (async () => {
    for (const candidate of candidates) {
      try {
        const probe = await fetch(`${candidate}/health`)
        const type = probe.headers.get('Content-Type') ?? ''
        if (!type.includes('json')) continue
        await probe.json()
        API_BASE = candidate
        return candidate
      } catch { /* try the next candidate */ }
    }
    API_BASE = PUBLIC_API_BASE
    return PUBLIC_API_BASE
  })()
  return resolving
}

// Ask early so `apiUrl()` links are correct as soon as the panel renders.
void resolveApiBase()

/**
 * Absolute URL of an API path, for links that leave the SPA (subscription
 * links, status pages, the Telegram webhook).
 *
 * `API_BASE` is `/api` when the worker serves the panel itself — then the host
 * is the current origin. When the frontend is hosted statically (Freebuff, a
 * CDN, GitHub Pages…) `VITE_API_BASE` is absolute and the API lives on another
 * origin, so those links must point at the API host, not at the static one.
 */
export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  return /^https?:\/\//i.test(API_BASE) ? `${API_BASE}${p}` : `${window.location.origin}${API_BASE}${p}`
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

interface ApiOptions {
  method?: string
  body?: unknown
}

/** Authenticated JSON request to the panel's worker API. */
export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  const base = await resolveApiBase()
  let resp: Response
  try {
    resp = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
  } catch {
    throw new ApiError('خطا در اتصال به سرور', 0)
  }

  // Session expired → clear local state so auth flow restarts.
  // 403 means "authenticated but not allowed" — that must never log the user out.
  if (resp.status === 401 && !path.startsWith('/auth')) {
    clearToken()
    // Tell the auth provider so ProtectedRoute bounces to /auth instead of
    // leaving the user on a page whose every request now fails.
    window.dispatchEvent(new Event('miliconfig:session-expired'))
  }

  const contentType = resp.headers.get('Content-Type') ?? ''
  const text = await resp.text().catch(() => '')
  let data: unknown = null
  try { data = text && contentType.includes('json') ? JSON.parse(text) : null } catch { /* non-JSON */ }

  if (!resp.ok) {
    const message =
      (data as { error?: string } | null)?.error ??
      (resp.status === 401 ? 'نشست شما منقضی شده است. دوباره وارد شوید.' :
       resp.status === 403 ? 'به این بخش دسترسی ندارید.' :
       resp.status === 404 || resp.status === 405 ? 'بک‌اند اینجا اجرا نمی‌شود — پنل روی کلودفلر (Workers/Pages) مستقر نشده یا آدرس آن درست نیست.' :
       `خطای سرور (${resp.status})`)
    throw new ApiError(message, resp.status)
  }
  return data as T
}

/**
 * Authenticated raw fetch — for endpoints that stream a body instead of JSON
 * (e.g. the real speed test, which counts actual downloaded bytes).
 */
export async function apiRaw(path: string): Promise<Response> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const base = await resolveApiBase()
  try {
    return await fetch(`${base}${path}`, { headers })
  } catch {
    throw new ApiError('خطا در اتصال به سرور', 0)
  }
}

/**
 * Authenticated file download.
 *
 * A plain `<a href="/api/...">` cannot carry the Bearer token, so the server
 * would answer 401 (or download the error body). Everything the panel exports
 * must go through here: the token is attached, the response is read as a blob
 * and saved with the filename the server chose.
 */
export async function downloadApi(path: string, fallbackName = 'download.json'): Promise<void> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  const base = await resolveApiBase()
  let resp: Response
  try {
    resp = await fetch(`${base}${path}`, { headers })
  } catch {
    throw new ApiError('خطا در اتصال به سرور', 0)
  }

  if (resp.status === 401) {
    clearToken()
    throw new ApiError('نشست شما منقضی شده است. دوباره وارد شوید.', resp.status)
  }
  if (resp.status === 403) throw new ApiError('به این بخش دسترسی ندارید.', resp.status)
  if (!resp.ok) throw new ApiError(`خطای سرور (${resp.status})`, resp.status)

  const disposition = resp.headers.get('Content-Disposition') ?? ''
  const name = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? fallbackName
  const url = URL.createObjectURL(await resp.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
