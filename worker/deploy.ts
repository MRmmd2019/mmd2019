import type { Env } from './env'
import { nowIso, genId, edgetunnelSubToken, safeJsonParse } from './util'
import { notifyDeployment } from './telegram'
import {
  commitPinnedRawUrl,
  fetchGithubHeadCommit,
  parseRawGithubUrl,
  verifyWorkerSource,
  type RawGithubRef,
} from './source-verify'
import { WORKER_SOURCE_KIND, type WorkerSourceKind } from '../shared/worker-links'
import {
  GITHUB_ENTRY_CANDIDATES,
  WRANGLER_CONFIG_FILES,
  githubRepoLabel,
  isWorkerEntryPath,
  parseGithubSourceUrl,
  rawGithubFileUrl,
} from '../shared/github-source'

// ── Ported 1:1 from the original cf-deploy function (Supabase → D1) ────────
// The deploy steps, source URLs, bindings and fallbacks are identical to the
// version the project originally shipped with.

const API_BASE = 'https://api.cloudflare.com/client/v4'

export interface WorkerSourceConfig {
  url: string
  label: string
  compat: string
  kvBinding: string
  configKey: string
  configFormat: 'edgetunnel' | 'custom'
  uuidEnvName: string
  fallbackUrls?: string[]
  /** Optional per-source compatibility flags override (defaults to the panel's). */
  compatFlags?: string[]
  /**
   * Identity marker: a short string this project's own upstream always
   * contains. The downloaded file has to contain it before it is uploaded, so
   * a source can never deploy *another* project's worker under its name (see
   * `expectMarker` in worker/source-verify.ts). Empty = no check (only for
   * arbitrary GitHub repos, whose content we cannot know in advance).
   */
  expectMarker?: string
  /**
   * Which routing model the worker implements — this is what decides the
   * panel path and the subscription link, so the two can never be guessed
   * wrong again:
   *
   *  - `edgetunnel` (cmliu): the dashboard lives at a FIXED `/admin` (or
   *    `/login`), and the subscription is `/sub?token=<md5(host+uuid)>`.
   *  - `custom` / `nexus` (CFnew): the dashboard and the subscription are both
   *    served under the UUID path — `/<uuid>` is the panel, `/<uuid>/sub` the
   *    raw sub link. There is no `/sub` at the worker root.
   *  - `zeus`: the whole worker is a D1-backed panel; a user's subscription is
   *    `/sub/<username>`, which only exists after an account is created in the
   *    panel — there is no deploy-time sub link at all.
   */
  kind: WorkerSourceKind
}

const WORKER_SOURCES: Record<string, WorkerSourceConfig> = {
  edgetunnel: {
    url: 'https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js',
    label: 'cmliu/edgetunnel',
    compat: '2025-11-04',
    kvBinding: 'KV',
    configKey: 'config.json',
    configFormat: 'edgetunnel',
    uuidEnvName: 'UUID',
    kind: WORKER_SOURCE_KIND.edgetunnel,
    // Present 214× in cmliu's file (its KV config object). A file without it is
    // not edgetunnel — the check exists so a wrong URL can never masquerade as
    // this source and overwrite a live worker.
    expectMarker: 'config_JSON',
  },
  edgetunnel_kv: {
    url: 'https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js',
    label: 'cmliu/edgetunnel (KV mode)',
    compat: '2025-11-04',
    kvBinding: 'KV',
    configKey: 'config.json',
    configFormat: 'edgetunnel',
    uuidEnvName: 'UUID',
    kind: WORKER_SOURCE_KIND.edgetunnel_kv,
    expectMarker: 'config_JSON',
  },
  custom: {
    url: 'https://raw.githubusercontent.com/Alibakhshi-qr/miliconfig-pro/main/public/repo/worker-source.js',
    label: 'Custom worker (CFnew v2.9.8c)',
    compat: '2025-01-01',
    kvBinding: 'C',
    configKey: 'c',
    configFormat: 'custom',
    uuidEnvName: 'u',
    // The public mirrors of this (private-repo) source 404, so the copy
    // bundled with the panel is always tried as the fallback.
    fallbackUrls: [
      'https://raw.githubusercontent.com/miladjahani/miliconfigpro-v1/main/public/repo/worker-source.js',
      '/repo/worker-source.js',
    ],
    kind: WORKER_SOURCE_KIND.custom,
    // CFnew's own header — every copy of this worker (mirror and bundled) has it.
    expectMarker: 'CFnew',
  },
  nexus: {
    url: 'https://raw.githubusercontent.com/miladjahani/miliconfigpro-v1/main/public/repo/nexus.js',
    label: 'NEXUS — نسل جدید (پنل داخلی + نقشه زنده + ساب‌نویس خودکار)',
    compat: '2025-01-01',
    kvBinding: 'C',
    configKey: 'c',
    configFormat: 'custom',
    uuidEnvName: 'u',
    // The repo is private, so every raw mirror 404s. Without the bundled copy
    // as a fallback the deploy dies with "failed to fetch worker source".
    fallbackUrls: [
      'https://raw.githubusercontent.com/Alibakhshi-qr/miliconfig-pro/main/public/repo/nexus.js',
      '/repo/nexus.js',
    ],
    kind: WORKER_SOURCE_KIND.nexus,
    expectMarker: 'NEXUS',
  },
  zeus: {
    // ZEUS PANEL (panel-zeus/Z-E-U-S) — full D1 panel, anti-censorship core:
    // TLS fragmentation, ClientHello fingerprint spoofing, D1-backed users.
    url: 'https://raw.githubusercontent.com/panel-zeus/Z-E-U-S/main/Source.js',
    label: 'ZEUS PANEL (panel-zeus/Z-E-U-S)',
    // Read from the panel's own source (compatibility_date: "2026-07-10").
    compat: '2026-07-10',
    kvBinding: '',
    configKey: '',
    configFormat: 'custom',
    uuidEnvName: '',
    kind: WORKER_SOURCE_KIND.zeus,
    expectMarker: 'GLOBAL_TRAFFIC_CACHE',
  },
  miliconfigzeus: {
    url: 'https://raw.githubusercontent.com/miladjahani/miliconfigzeus/main/Source-2.js',
    label: 'miliconfig zeus (full D1 panel)',
    compat: '2025-01-01',
    kvBinding: '',
    configKey: '',
    configFormat: 'custom',
    uuidEnvName: '',
    kind: WORKER_SOURCE_KIND.miliconfigzeus,
    expectMarker: 'GLOBAL_TRAFFIC_CACHE',
  },
  nova: {
    url: 'https://raw.githubusercontent.com/IRNova/Nova-Proxy/main/worker.js',
    label: 'Nova Proxy (full D1+KV panel)',
    compat: '2026-07-30',
    kvBinding: 'KV',
    configKey: '',
    configFormat: 'custom',
    uuidEnvName: '',
    // Routing like zeus: the whole worker is a self-contained admin panel.
    // The dashboard lives at a fixed /admin (setup wizard on first visit),
    // login at /login, and a user subscription is /sub?token=… issued by
    // the panel per user — there is no deploy-time sub link.
    kind: WORKER_SOURCE_KIND.nova,
    // Nova's own wrangler.jsonc: nodejs_compat only — with nova's own
    // compat date given above. global_fetch_strictly_public is NOT set so
    // nova keeps its own fetch behaviour.
    compatFlags: ['nodejs_compat'],
    // Nova's protected release banner (`/*! Nova 4.9.4 protected release …`).
    // This is the check that makes "the deployment said Nova but shipped
    // edgetunnel" impossible: cmliu's file does not contain it, so a wrong
    // URL/mapping now stops the deployment instead of overwriting the worker.
    expectMarker: 'Nova',
  },
}

/**
 * Exact lookup: `null` when this build does not know the id.
 *
 * Deliberately NOT a fallback. `WORKER_SOURCES[id] ?? WORKER_SOURCES.edgetunnel`
 * (the old behaviour of both the deploy and the update path) turned any unknown
 * id — an older panel's source, a typo, a source removed in a later version —
 * into a silent edgetunnel deployment: the row said "Nova", the code on
 * Cloudflare was cmliu's worker, and the panel could not update itself out of
 * that state. An empty id still means "nothing chosen" and gets the default.
 */
export function lookupWorkerSource(workerSource: string | null | undefined): WorkerSourceConfig | null {
  if (!workerSource) return WORKER_SOURCES.edgetunnel
  return WORKER_SOURCES[workerSource] ?? null
}

/**
 * Source config for display/legacy callers. Only valid for ids that exist —
 * the deploy and update engines use {@link lookupWorkerSource} and refuse an
 * unknown one.
 */
export function workerSourceConfig(workerSource: string | null | undefined): WorkerSourceConfig {
  return lookupWorkerSource(workerSource) ?? WORKER_SOURCES.edgetunnel
}

export interface FetchedSource {
  code: string
  url: string
  /** raw.githubusercontent ETag = sha256 of the file — a perfect "did upstream
   *  change?" fingerprint, so a re-deploy never pushes an identical script. */
  etag: string
  usedFallback: boolean
  /** SHA-256 of the verified bytes. */
  sha256: string
  /** Upstream revision the bytes were proven against (null when unverified). */
  commitSha: string | null
  /** Published blob checksum that matched these bytes (null when unverified). */
  blobSha: string | null
  /** True only when GitHub's published checksum confirmed these exact bytes. */
  checksumVerified: boolean
  /** Non-fatal remark (checksum unavailable, local checks only). */
  note?: string
}

export interface FetchWorkerSourceResult {
  /** The first candidate that downloaded *and* passed integrity verification. */
  source: FetchedSource | null
  /** One line per rejected candidate, for the deployment log. */
  errors: string[]
}

/**
 * Download a worker source from its upstream repository, trying the primary
 * URL first and then any fallback (mirrors / the copy bundled with this panel)
 * so a moved or renamed repo can never 404 a deployment.
 *
 * Every candidate is verified before it is accepted (see worker/source-verify.ts):
 * a download that stopped halfway is exactly what turns a healthy worker into a
 * permanent `error code: 1101`, so a file that fails the size, marker or
 * checksum screen is dropped and the next candidate is tried — never uploaded.
 */
export async function fetchWorkerSource(
  sourceConfig: WorkerSourceConfig,
  fallbackUrls: string[],
): Promise<FetchWorkerSourceResult> {
  const errors: string[] = []
  for (const [i, url] of [sourceConfig.url, ...fallbackUrls].entries()) {
    const label = `${sourceConfig.label}${i > 0 ? ' (fallback)' : ''}`
    try {
      const resp = await fetch(url)
      if (!resp.ok || Number(resp.headers.get('content-length') ?? '1') === 0) {
        errors.push(`${label}: دریافت نشد (HTTP ${resp.status})`)
        continue
      }
      const text = await resp.text()
      if (!text.trim().length) {
        errors.push(`${label}: پاسخ خالی بود`)
        continue
      }
      const ref: RawGithubRef | null = parseRawGithubUrl(url)
      // Pin the check to an exact revision: the branch's current commit. The
      // checksum and the rollback target then refer to the same commit instead
      // of a branch name that moves under us. When the commit lookup fails
      // (rate limit), the checksum is still verified — against the branch head
      // as it is right now — and the branch is what gets recorded.
      const revision = ref ? (await fetchGithubHeadCommit(ref)) ?? undefined : undefined
      const verified = await verifyWorkerSource(text, { ref, revision, expectMarker: sourceConfig.expectMarker })
      if (!verified.ok) {
        errors.push(`${label}: ${verified.reason ?? 'بررسی صحت فایل ناموفق بود'}`)
        continue
      }
      return {
        source: {
          code: text,
          url,
          etag: (resp.headers.get('etag') ?? '').trim(),
          usedFallback: i > 0,
          sha256: verified.sha256,
          commitSha: verified.commitSha,
          blobSha: verified.blobSha,
          checksumVerified: verified.checksumVerified,
          note: verified.note,
        },
        errors,
      }
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : 'خطای شبکه'}`)
      // try next candidate
    }
  }
  return { source: null, errors }
}

/**
 * The exact same file at a pinned revision — the rollback path of the updater.
 *
 * The checksum of that revision is re-verified before the bytes are returned,
 * so a rolled-back deployment is as verified as a fresh one.
 */
export async function fetchPinnedWorkerSource(
  sourceUrl: string,
  commit: string,
  /** Identity marker of the source, so a rollback cannot land a foreign file either. */
  expectMarker?: string,
): Promise<FetchedSource | null> {
  const ref = parseRawGithubUrl(sourceUrl)
  if (!ref || !commit) return null
  const url = commitPinnedRawUrl(ref, commit)
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const text = await resp.text()
    const verified = await verifyWorkerSource(text, { ref, revision: commit, expectMarker })
    if (!verified.ok) return null
    return {
      code: text,
      url,
      etag: (resp.headers.get('etag') ?? '').trim(),
      usedFallback: true,
      sha256: verified.sha256,
      commitSha: verified.commitSha ?? commit,
      blobSha: verified.blobSha,
      checksumVerified: verified.checksumVerified,
      note: verified.note,
    }
  } catch {
    return null
  }
}

// ── «استقرار از هر مخزن گیت‌هاب» ────────────────────────────────────────
//
// The user may paste any GitHub repository (or a file inside one) and have it
// deployed as a Cloudflare Worker. Two things make that possible without
// guessing:
//
//   1. the worker entry file is resolved from the repo itself — the `main`
//      field of its own wrangler config first (that is the file Cloudflare
//      would build), then the conventional single-file worker paths;
//   2. the file is verified exactly like a catalogued source: GitHub's
//      published blob checksum for the revision that was read, so a truncated
//      download is refused instead of being uploaded as a broken script.
//
// No identity marker is set for this mode — we cannot know a stranger's
// project in advance — but the checksum still pins the bytes to that repo and
// revision, which is what the other sources' markers add on top.

/** Ask the GitHub API for a repo's default branch (`main` when unavailable). */
async function fetchGithubDefaultBranch(owner: string, repo: string): Promise<string> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'miliconfig-pro' },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return 'main'
    const data = (await resp.json().catch(() => null)) as { default_branch?: string } | null
    return data?.default_branch?.trim() || 'main'
  } catch {
    return 'main'
  }
}

/** True when `path` exists as a file at `branch` in the repo. */
async function githubFileExists(owner: string, repo: string, branch: string, path: string): Promise<boolean> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'miliconfig-pro' },
        signal: AbortSignal.timeout(8000),
      },
    )
    if (!resp.ok) return false
    const data = (await resp.json().catch(() => null)) as { type?: string } | null
    return data?.type === 'file'
  } catch {
    return false
  }
}

/** Read one file of a repo as text (used for the wrangler config). */
async function readGithubFile(owner: string, repo: string, branch: string, path: string): Promise<string> {
  try {
    const resp = await fetch(rawGithubFileUrl({ owner, repo, branch, path }, path), {
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return ''
    return await resp.text()
  } catch {
    return ''
  }
}

/** What a repo's own wrangler config says about the worker it builds. */
interface WranglerHints {
  main?: string
  compatDate?: string
  compatFlags?: string[]
}

/**
 * Parse the entry/compat fields out of `wrangler.toml`, `.jsonc` or `.json`.
 *
 * Only the three fields that matter here are read, and a config that cannot be
 * parsed simply yields nothing — the caller falls back to the conventional
 * entry-file list instead of failing the deployment.
 */
export function parseWranglerHints(text: string): WranglerHints {
  if (!text.trim()) return {}
  const hints: WranglerHints = {}
  const fromJson = (): WranglerHints | null => {
    try {
      // JSONC allows // comments; strip them before parsing.
      const cleaned = text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
      const data = JSON.parse(cleaned) as { main?: unknown; compatibility_date?: unknown; compatibility_flags?: unknown }
      const out: WranglerHints = {}
      if (typeof data.main === 'string') out.main = data.main
      if (typeof data.compatibility_date === 'string') out.compatDate = data.compatibility_date
      if (Array.isArray(data.compatibility_flags)) {
        out.compatFlags = data.compatibility_flags.filter((f): f is string => typeof f === 'string')
      }
      return out
    } catch {
      return null
    }
  }
  const json = fromJson()
  if (json) return json
  const main = text.match(/^\s*main\s*=\s*["']([^"']+)["']/m)
  const compatDate = text.match(/^\s*compatibility_date\s*=\s*["']([^"']+)["']/m)
  const flags = text.match(/^\s*compatibility_flags\s*=\s*\[([^\]]*)\]/m)
  if (main?.[1]) hints.main = main[1]
  if (compatDate?.[1]) hints.compatDate = compatDate[1]
  if (flags?.[1]) {
    hints.compatFlags = flags[1]
      .split(',')
      .map((f) => f.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
  }
  return hints
}

/** Result of turning a pasted GitHub URL into a deployable source. */
export type GithubSourceResolution =
  | { ok: true; config: WorkerSourceConfig; entryPath: string; repoLabel: string; branch: string }
  | { ok: false; error: string }

/**
 * Turn a GitHub URL into a verified-deployable worker source.
 *
 * Rejects anything that cannot be resolved to a single file with a message
 * that names what was tried — the user sees the reason in the deploy log and
 * in the wizard, not a network error.
 */
export async function buildGithubSourceConfig(sourceUrl: string): Promise<GithubSourceResolution> {
  const parsed = parseGithubSourceUrl(sourceUrl)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const ref = parsed.ref
  const repoLabel = githubRepoLabel(ref)
  const branch = ref.branch || (await fetchGithubDefaultBranch(ref.owner, ref.repo))

  // ── Entry file: explicit path first, then wrangler `main`, then the usual
  // single-file worker locations.
  let entryPath = ''
  let hints: WranglerHints = {}
  if (ref.path && isWorkerEntryPath(ref.path) && (await githubFileExists(ref.owner, ref.repo, branch, ref.path))) {
    entryPath = ref.path
  } else {
    const dir = ref.path ? `${ref.path.replace(/\/+$/, '')}/` : ''
    for (const file of WRANGLER_CONFIG_FILES) {
      const text = await readGithubFile(ref.owner, ref.repo, branch, `${dir}${file}`)
      if (!text) continue
      hints = parseWranglerHints(text)
      if (hints.main) break
    }
    if (hints.main) {
      const main = hints.main.replace(/^\.\//, '')
      const candidates = isWorkerEntryPath(main) ? [`${dir}${main}`] : [`${dir}${main}.js`, `${dir}${main}/index.js`]
      for (const candidate of candidates) {
        if (await githubFileExists(ref.owner, ref.repo, branch, candidate)) {
          entryPath = candidate
          break
        }
      }
    }
    if (!entryPath) {
      // A GitHub URL that points at a directory is tried relative to that
      // directory first; a repo URL is tried at the root.
      for (const candidate of GITHUB_ENTRY_CANDIDATES.map((c) => `${dir}${c}`)) {
        if (await githubFileExists(ref.owner, ref.repo, branch, candidate)) {
          entryPath = candidate
          break
        }
      }
    }
    if (!entryPath && ref.path && isWorkerEntryPath(ref.path)) entryPath = ref.path
    if (!entryPath) {
      return {
        ok: false,
        error:
          `فایل ورکر در مخزن ${repoLabel} پیدا نشد. `+
          `این فایل‌ها بررسی شدند: ${GITHUB_ENTRY_CANDIDATES.join('، ')}. `+
          'آدرس مستقیم فایل را بدهید (مثلاً https://github.com/owner/repo/blob/main/worker.js) — ورکر باید یک فایل تک‌ماژول باشد (TS باید از قبل بیلد شده باشد).',
      }
    }
  }

  const config: WorkerSourceConfig = {
    url: rawGithubFileUrl(ref, entryPath, branch),
    label: `GitHub — ${repoLabel} (${entryPath})`,
    // The repo's own wrangler config is the authority for compat; the panel's
    // defaults are the fallback so a repo without one still deploys.
    compat: hints.compatDate || '2025-01-01',
    ...(hints.compatFlags?.length ? { compatFlags: hints.compatFlags } : {}),
    // Storage is opt-in for an unknown repo: the user ticks KV/D1 in the wizard
    // and the bindings are created here; nothing is provisioned otherwise.
    kvBinding: '',
    configKey: '',
    configFormat: 'custom',
    uuidEnvName: '',
    kind: WORKER_SOURCE_KIND.github,
    fallbackUrls: [],
  }
  return { ok: true, config, entryPath, repoLabel, branch }
}

/**
 * Keys of the **removed** obfuscation feature.
 *
 * The obfuscated format is gone from the code (it was incompatible with the
 * Cloudflare Workers runtime and made the platform refuse to run the script),
 * and a panel that still carries the setting has to be cleaned up rather than
 * left with a switch nothing honours any more. Nothing writes these keys
 * today; the guard is here so an older record can never bring the broken mode
 * back through an update.
 */
const LEGACY_OBFUSCATION_KEYS = ['obfuscate', 'obfuscation', 'obfuscated', 'source_obfuscated'] as const

/** Drop the removed obfuscation setting from a stored deployment config. */
export function stripLegacyObfuscation(cfg: Record<string, unknown>): boolean {
  let changed = false
  for (const key of LEGACY_OBFUSCATION_KEYS) {
    if (key in cfg) {
      delete cfg[key]
      changed = true
    }
  }
  return changed
}

/** Merge a patch into a deployment's JSON config (never overwrites the rest). */
export async function patchDeploymentConfig(
  env: Env,
  deploymentId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare('SELECT config FROM deployments WHERE id = ?')
    .bind(deploymentId)
    .first<{ config: string | null }>()
  const cfg = safeJsonParse<Record<string, unknown>>(row?.config ?? '', {})
  stripLegacyObfuscation(cfg)
  Object.assign(cfg, patch)
  await env.DB.prepare('UPDATE deployments SET config = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(cfg), nowIso(), deploymentId)
    .run()
  return cfg
}

/**
 * Store the upstream fingerprint on the deployment so "update from repo" can
 * tell the user whether anything actually changed — and, when `markGood` is
 * set, remember the revision as the one a rollback may return to.
 */
export async function recordSourceFingerprint(
  env: Env,
  deploymentId: string,
  source: {
    url: string
    etag: string
    bytes: number
    sha256?: string
    commitSha?: string | null
    blobSha?: string | null
    checksumVerified?: boolean
    /** These bytes are known to run — remember them as the rollback target. */
    markGood?: boolean
  },
): Promise<void> {
  const patch: Record<string, unknown> = {
    source_url: source.url,
    source_etag: source.etag,
    source_bytes: source.bytes,
    source_synced_at: nowIso(),
  }
  if (source.sha256) patch.source_sha256 = source.sha256
  if (source.commitSha) patch.source_commit = source.commitSha
  if (source.blobSha) patch.source_blob_sha = source.blobSha
  patch.source_checksum_verified = !!source.checksumVerified
  if (source.markGood) {
    patch.source_last_good_url = source.url
    if (source.commitSha) patch.source_last_good_commit = source.commitSha
    if (source.sha256) patch.source_last_good_sha256 = source.sha256
    patch.source_last_good_at = nowIso()
  }
  await patchDeploymentConfig(env, deploymentId, patch)
}

/** Input shared by the web API and the Telegram bot when starting a deploy. */
export interface StartDeploymentInput {
  userId: string
  /** Worker script name (lowercase letters, digits and hyphens). */
  name: string
  uuid: string
  /** Row id of the Cloudflare token to use (must belong to the user + be active). */
  cfTokenId: string
  method?: 'workers' | 'pages'
  workerSource?: string
  /**
   * "Deploy from any GitHub repository": the URL the user pasted. When set it
   * wins over `workerSource` and the entry file is resolved from the repo.
   */
  sourceUrl?: string
  /** Storage an arbitrary GitHub repo may want (nothing is created by default). */
  bindings?: { kv?: boolean; d1?: boolean }
  proxyip?: string
  adminPassword?: string
  customPath?: string
  /** Panel origin, used for the bundled-source fallback and the wizard link. */
  origin: string
}

export type StartDeploymentResult = { ok: true; id: string } | { ok: false; error: string }

/**
 * Validate + create a deployment row and hand it to the deploy engine.
 * Extracted so the web API and the Telegram bot run the exact same checks
 * (name/uuid/token/quota) and can never drift apart.
 */
export async function startDeployment(
  env: Env,
  ctx: ExecutionContext,
  input: StartDeploymentInput,
): Promise<StartDeploymentResult> {
  const name = (input.name ?? '').trim().toLowerCase()
  const uuid = (input.uuid ?? '').trim()
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) return { ok: false, error: 'نام ورکر نامعتبر است' }
  if (!uuid) return { ok: false, error: 'UUID الزامی است' }

  const tokenRow = await env.DB.prepare("SELECT id, token FROM cf_tokens WHERE id = ? AND user_id = ? AND status = 'active'")
    .bind(input.cfTokenId ?? '', input.userId)
    .first<{ id: string; token: string }>()
  if (!tokenRow) return { ok: false, error: 'توکن فعال انتخاب‌شده پیدا نشد' }

  const quotaRow = await env.DB.prepare('SELECT max_deployments FROM users WHERE id = ?')
    .bind(input.userId)
    .first<{ max_deployments: number | null }>()
  const quota = quotaRow?.max_deployments ?? 100
  const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM deployments WHERE user_id = ?')
    .bind(input.userId)
    .first<{ c: number }>()
  if ((count?.c ?? 0) >= quota) return { ok: false, error: `به سقف تعداد ورکرهای خود (${quota}) رسیده‌اید` }

  // The pasted GitHub URL (and the storage choice made next to it) has to
  // survive on the record: the update/recover path re-reads the file from the
  // same repository instead of from a source id it would not find.
  const sourceUrl = (input.sourceUrl ?? '').trim()
  const workerSource = sourceUrl ? 'github' : input.workerSource ?? 'edgetunnel'
  const initialConfig: Record<string, unknown> = {}
  // `repo_url` (the URL the user pasted) is what the update path re-resolves;
  // `source_url` belongs to the fetched-file fingerprint written on every
  // deploy/update, so the two must not share a key.
  if (sourceUrl) initialConfig.repo_url = sourceUrl
  if (input.bindings) initialConfig.requested_bindings = { kv: !!input.bindings.kv, d1: !!input.bindings.d1 }

  const id = genId()
  await env.DB.prepare(
    `INSERT INTO deployments (id, user_id, name, worker_code, config, status, uuid, custom_path, method, worker_source, created_at, updated_at)
     VALUES (?, ?, ?, '[auto-loaded]', ?, 'deploying', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, input.userId, name, JSON.stringify(initialConfig), uuid, input.customPath || null,
      input.method === 'pages' ? 'pages' : 'workers', workerSource, nowIso(), nowIso())
    .run()

  await env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(genId(), input.userId, 'deployment_created', 'deployment', name, nowIso())
    .run()

  ctx.waitUntil(runDeployment(env, {
    deployment_id: id,
    worker_name: name,
    cf_token: tokenRow.token,
    cf_token_row_id: tokenRow.id,
    uuid,
    method: input.method === 'pages' ? 'pages' : 'workers',
    worker_source: workerSource,
    source_url: sourceUrl || undefined,
    extra_bindings: input.bindings,
    proxyip: input.proxyip || undefined,
    admin_password: input.adminPassword || undefined,
    custom_path: input.customPath || undefined,
    origin: input.origin,
  }))

  return { ok: true, id }
}

export interface DeployJob {
  deployment_id: string
  worker_name: string
  cf_token: string
  cf_token_row_id?: string | null
  uuid: string
  method: 'workers' | 'pages'
  worker_source: string
  /** "Deploy from any GitHub repository" — resolved into a source at run time. */
  source_url?: string
  /** KV/D1 to bind for a GitHub source (nothing is created unless asked). */
  extra_bindings?: { kv?: boolean; d1?: boolean }
  proxyip?: string
  admin_password?: string
  custom_path?: string
  origin: string
}

/**
 * How long a deployment may sit in `pending`/`deploying` before it is treated as
 * lost. The whole flow is bounded well under a minute now (uploads + a capped
 * self-check), so a row that is still running after this long belongs to a task
 * the runtime killed — the user would otherwise stare at «در حال استقرار»
 * forever with no way to tell that nothing is happening.
 */
const STALE_DEPLOY_MS = 5 * 60 * 1000

/**
 * Close out deployments whose background task died before it could report.
 * Returns how many rows were reaped. Timestamps are compared in the same ISO
 * format they are stored in, so no SQLite date parsing is involved.
 */
export async function reapStaleDeployments(env: Env, userId: string): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_DEPLOY_MS).toISOString()
  const message = 'استقرار نیمه‌کاره ماند — اجرای پس‌زمینه قطع شد. دوباره تلاش کنید.'
  const r = await env.DB.prepare(
    `UPDATE deployments
        SET status = 'failed', error_message = ?, updated_at = ?
      WHERE user_id = ? AND status IN ('pending', 'deploying') AND updated_at < ?`,
  )
    .bind(message, new Date().toISOString(), userId, cutoff)
    .run()
  return (r.meta?.changes as number | undefined) ?? 0
}

async function appendLog(env: Env, id: string, line: string): Promise<void> {
  const row = await env.DB.prepare('SELECT logs FROM deployments WHERE id = ?').bind(id).first<{ logs: string | null }>()
  const existing = row?.logs ?? ''
  // `updated_at` doubles as the liveness heartbeat the stale-deployment sweep
  // reads, so every log line counts as progress.
  await env.DB.prepare('UPDATE deployments SET logs = ?, updated_at = ? WHERE id = ?')
    .bind(existing + line + '\n', nowIso(), id)
    .run()
}

/** POST a D1 query through the Cloudflare API (used to pre-create the zeus
 *  panel schema on a freshly provisioned database). */
async function d1Query(
  apiBase: string,
  accountId: string,
  dbId: string,
  headers: Record<string, string>,
  sql: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`${apiBase}/accounts/${accountId}/d1/database/${dbId}/query`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    })
    if (!resp.ok) return false
    const data = (await resp.json().catch(() => ({}))) as {
      success?: boolean
      result?: Array<{ error?: string; errors?: Array<{ message?: string }> }>
    }
    // A per-statement `error` (e.g. "no such table") still returns HTTP 200 +
    // success:true — check the payload too so failures are visible in logs.
    const first = data.result?.[0]
    if (!data.success || first?.error) return false
    return true
  } catch {
    return false
  }
}

/** Pre-create the ZEUS panel's D1 schema (mirrors DbService.ensureSchema in
 *  panel-zeus/Z-E-U-S Source.js). The worker also self-initializes on its
 *  first request, but seeding the tables here means the very first visitor
 *  never races an empty database and the deploy log can state what happened.
 *  Every statement is `IF NOT EXISTS` / idempotent UPDATE, so re-running this
 *  against a live panel is harmless. */
const ZEUS_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, uuid TEXT, limit_gb REAL, expiry_days INTEGER, ips TEXT, connection_type TEXT, tls TEXT, port INTEGER, used_gb REAL DEFAULT 0, is_active INTEGER DEFAULT 1, last_active INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `ALTER TABLE users ADD COLUMN advanced_frag TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN cipher_suites TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN tls_mask TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1`,
  `ALTER TABLE users ADD COLUMN last_active INTEGER`,
  `ALTER TABLE users ADD COLUMN fingerprint TEXT DEFAULT 'chrome'`,
  `ALTER TABLE users ADD COLUMN max_connections INTEGER`,
  `ALTER TABLE users ADD COLUMN limit_req INTEGER`,
  `ALTER TABLE users ADD COLUMN used_req INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN ip_limit INTEGER DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN active_ips TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN block_porn INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN block_ads INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN frag_len TEXT DEFAULT '200-3000'`,
  `ALTER TABLE users ADD COLUMN frag_int TEXT DEFAULT '1-2'`,
  `ALTER TABLE users ADD COLUMN lifetime_used_gb REAL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN user_proxy_ip TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN user_proxy_iata TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN user_socks5 TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN auto_reset_vol_days INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN auto_reset_req_days INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN last_reset_vol_time INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN last_reset_req_time INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN auto_rotate_ip INTEGER DEFAULT 1`,
  `ALTER TABLE users ADD COLUMN rotate_time INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN ip_operator TEXT DEFAULT 'all'`,
  `ALTER TABLE users ADD COLUMN ip_count INTEGER DEFAULT 15`,
  `ALTER TABLE users ADD COLUMN last_rotate_time INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN auto_rotate_user_proxy INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN start_on_first_connect INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN first_connection_time INTEGER DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN trojan_hash TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN enable_direct INTEGER DEFAULT 1`,
  `UPDATE users SET ip_limit = max_connections WHERE ip_limit IS NULL AND max_connections IS NOT NULL`,
  `UPDATE users SET lifetime_used_gb = used_gb WHERE lifetime_used_gb = 0 OR lifetime_used_gb IS NULL`,
]

async function seedZeusSchema(
  apiBase: string,
  accountId: string,
  dbId: string,
  headers: Record<string, string>,
): Promise<{ ok: number; failed: number }> {
  let ok = 0
  let failed = 0
  for (const sql of ZEUS_SCHEMA_STATEMENTS) {
    // `ALTER TABLE … ADD COLUMN` fails when the column already exists — that
    // is expected on a re-run, so a failure here is not an error condition.
    const done = await d1Query(apiBase, accountId, dbId, headers, sql)
    if (done) ok++
    else failed++
  }
  return { ok, failed }
}

/** Poll a freshly deployed worker until it answers with anything other than
 *  Cloudflare's uncaught-exception page (`error code: 1101`) or a transport
 *  error. A brand-new script needs a few seconds before its first invocation
 *  succeeds (route propagation + cold isolate); during that window every hit
 *  returns 1101. Returning early only when the worker really responds is what
 *  stops the UI from pointing at a dead URL. */
export async function waitForWorkerLive(
  url: string,
  attempts = 12,
  delayMs = 1500,
  /**
   * Hard wall-clock budget for the whole probe.
   *
   * This runs inside the deploy/update request, so an unbounded loop is a real
   * bug: 12 attempts × 8s fetch timeout + 1.5s delay is up to 114s, and both
   * the CDN (100s → 524) and the runtime's background-task allowance kill the
   * work long before that — leaving the deployment stuck on "در حال استقرار"
   * with no link. A live worker answers on the first try, so a short budget
   * loses nothing and guarantees the rest of the flow always runs.
   */
  totalBudgetMs = 25_000,
): Promise<boolean> {
  const deadline = Date.now() + totalBudgetMs
  for (let i = 0; i < attempts; i++) {
    if (Date.now() >= deadline) break
    try {
      const ctrl = new AbortController()
      const wait = Math.max(500, Math.min(8000, deadline - Date.now()))
      const timer = setTimeout(() => ctrl.abort(), wait)
      const resp = await fetch(url, { redirect: 'manual', signal: ctrl.signal }).finally(() => clearTimeout(timer))
      const text = await resp.text().catch(() => '')
      // Anything that is not the runtime-exception interstitial means the
      // script executed — 200/302/404/503 all count as "alive".
      if (!text.includes('error code: 1101')) return true
    } catch {
      // DNS not resolved yet / edge not propagated — keep polling.
    }
    if (Date.now() + delayMs >= deadline) break
    await new Promise((r) => setTimeout(r, delayMs))
  }
  return false
}

/**
 * The account's workers.dev subdomain, i.e. the middle label of
 * `<script>.<subdomain>.workers.dev`.
 *
 * `GET /accounts/:id/workers/subdomain` needs script read access and answers
 * `success: false` for a token that only carries account-level grants, so the
 * panel used to fall back to `https://<script>.workers.dev` — a host that can
 * never resolve. Every later step then polled that dead name until the runtime
 * killed the deployment. Falling back to a subdomain this account already
 * published (an older deployment's URL) keeps the address real, and an empty
 * result is now treated as a known limitation instead of a live URL.
 */
async function resolveWorkersSubdomain(
  env: Env,
  accountId: string,
  headers: Record<string, string>,
  workerName: string,
): Promise<string> {
  const read = async (): Promise<string> => {
    try {
      const resp = await fetch(`${API_BASE}/accounts/${accountId}/workers/subdomain`, { headers })
      const data = (await resp.json().catch(() => ({}))) as { result?: { subdomain?: string } }
      return (data.result?.subdomain ?? '').trim()
    } catch {
      return ''
    }
  }

  const known = await read()
  if (known) return known

  // No subdomain yet (first worker of a fresh account): register one, exactly
  // like the workers.dev-route fallback below does. Without this the URL stayed
  // `https://<script>.workers.dev`, which is not a host Cloudflare serves.
  const candidate = `edge-${workerName}`.replace(/[^a-z0-9-]/g, '').slice(0, 30)
  try {
    await fetch(`${API_BASE}/accounts/${accountId}/workers/subdomain`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subdomain: candidate }),
    })
  } catch {
    // Not permitted with this token — the stored-URL fallback below applies.
  }
  const registered = await read()
  if (registered) return registered

  // `%.workers.dev%` (not `%.workers.dev/%`): stored worker URLs have no
  // trailing path, so a slash-anchored LIKE matches nothing at all.
  const row = await env.DB.prepare(
    `SELECT worker_url FROM deployments
      WHERE cf_account_id = ? AND worker_url LIKE '%.workers.dev%'
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(accountId)
    .first<{ worker_url: string }>()
  const match = row?.worker_url?.match(/^https:\/\/[^.]+(?:\.[^.]+)*?\.([a-z0-9-]+)\.workers\.dev/i)
  return match?.[1] ?? ''
}

async function updateDeployment(env: Env, id: string, status: string, updates: Record<string, unknown>): Promise<void> {
  const sets = ['status = ?', 'updated_at = ?']
  const binds: unknown[] = [status, nowIso()]
  for (const [k, v] of Object.entries(updates)) {
    sets.push(`${k} = ?`)
    binds.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v)
  }
  binds.push(id)
  await env.DB.prepare(`UPDATE deployments SET ${sets.join(', ')} WHERE id = ?`).bind(...(binds as string[])).run()
}

export async function runDeployment(env: Env, job: DeployJob): Promise<void> {
  const { deployment_id } = job
  const worker_name = job.worker_name
  const cf_token = job.cf_token
  const uuid = job.uuid
  const custom_path = job.custom_path ?? ''
  const worker_source = job.worker_source || 'edgetunnel'

  // ── Resolve the source BEFORE anything is uploaded ──────────────────────
  // An id this build does not know is a hard failure. The old line here was
  // `WORKER_SOURCES[id] ?? WORKER_SOURCES.edgetunnel`, and that silent fallback
  // is how a deployment named "Nova" ended up running cmliu's worker: the name
  // was right, the code belonged to another project. A GitHub URL is resolved
  // the same way — into a verified single-file source — before the upload.
  let sourceConfig0: WorkerSourceConfig
  if (job.source_url) {
    const resolved = await buildGithubSourceConfig(job.source_url)
    if (!resolved.ok) {
      await appendLog(env, deployment_id, `✗ ${resolved.error}`)
      await updateDeployment(env, deployment_id, 'failed', { error_message: resolved.error })
      return
    }
    sourceConfig0 = resolved.config
    await appendLog(
      env,
      deployment_id,
      `✓ GitHub source resolved: ${resolved.repoLabel}@${resolved.branch} → ${resolved.entryPath}`,
    )
    await patchDeploymentConfig(env, deployment_id, {
      repo_url: job.source_url,
      source_entry: resolved.entryPath,
      source_repo: resolved.repoLabel,
    })
  } else {
    const known = lookupWorkerSource(worker_source)
    if (!known) {
      const msg =
        `منبع ورکر «${worker_source}» در این نسخه از پنل شناخته‌شده نیست — استقرار انجام نشد تا پنل اشتباهی روی حساب شما بالا نیاید.`
      await appendLog(env, deployment_id, `✗ ${msg}`)
      await updateDeployment(env, deployment_id, 'failed', { error_message: msg })
      return
    }
    sourceConfig0 = known
  }
  // Zeus is a full standalone panel — it always deploys as a Workers script.
  const method: DeployJob['method'] = sourceConfig0.kind === 'zeus' ? 'workers' : job.method
  const proxyip = job.proxyip ?? ''
  const admin_password = job.admin_password ?? ''
  const headers = { Authorization: `Bearer ${cf_token}` }

  try {
    const sourceConfig = sourceConfig0
    const compatDate = sourceConfig.compat
    // A GitHub source binds KV only when the user asked for it.
    const kvBindingName =
      sourceConfig.kind === 'github' && job.extra_bindings?.kv ? 'KV' : sourceConfig.kvBinding
    const configKvKey = sourceConfig.configKey
    const configFormat = sourceConfig.configFormat
    const uuidEnv = sourceConfig.uuidEnvName

    // ── Verify token + resolve account ──────────────────────────────────
    // `/user/tokens/verify` only accepts *user*-scoped tokens. An Account API
    // Token — the kind Cloudflare's own dashboard hands out for "Edit
    // Cloudflare Workers" — is rejected there with "Invalid API Token" even
    // though it works for every endpoint this panel uses, so a normal user
    // could never deploy. A failed verify therefore falls through to the
    // account listing below, which is the real capability check; only a token
    // that cannot list an account is treated as invalid (the old behaviour).
    await appendLog(env, deployment_id, 'verifying token...')
    const verifyResp = await fetch(`${API_BASE}/user/tokens/verify`, { headers })
    const verifyData = (await verifyResp.json().catch(() => ({}))) as { success?: boolean }
    if (verifyData.success) await appendLog(env, deployment_id, '✓ token verified (user token)')
    else await appendLog(env, deployment_id, 'ℹ user-token verify declined — checking account access instead (expected for Account API tokens)')

    // ── Resolve account ─────────────────────────────────────────────────
    await appendLog(env, deployment_id, 'listing accounts...')
    const accountsResp = await fetch(`${API_BASE}/accounts?per_page=50`, { headers })
    const accountsData = (await accountsResp.json().catch(() => ({}))) as { success?: boolean; result?: Array<{ id: string; name: string }> }
    if (!accountsData.success || !accountsData.result?.length) {
      await appendLog(env, deployment_id, '✗ invalid cloudflare token (cannot list accounts)')
      await updateDeployment(env, deployment_id, 'failed', { error_message: 'invalid cloudflare token' })
      return
    }
    await appendLog(env, deployment_id, '✓ token can deploy (account access confirmed)')
    const accountId = accountsData.result[0].id
    const accountName = accountsData.result[0].name
    await appendLog(env, deployment_id, `✓ account: ${accountName} (${accountId.slice(0, 8)}...)`)

    // ── Fetch worker source ─────────────────────────────────────────────
    await appendLog(env, deployment_id, `fetching worker source from ${sourceConfig.label}...`)
    let workerCode = ''
    // Primary URL first; if unavailable (e.g. repo moved/renamed), fall back to
    // the copy bundled with this panel so the default source can never 404.
// Fallbacks may be absolute (a mirror) or panel-relative (the copy bundled
    // in `public/repo/`, e.g. `/repo/nexus.js`). Relative ones are resolved
    // against this installation's own origin — the repo is private, so the raw
    // mirrors 404 and the bundled copy is the only one that works.
    const fallbackUrls = (sourceConfig.fallbackUrls ?? []).map((u) =>
      /^https?:\/\//i.test(u) ? u : `${job.origin.replace(/\/$/, '')}${u.startsWith('/') ? u : `/${u}`}`,
    )
    const fetchResult = await fetchWorkerSource(sourceConfig, fallbackUrls)
    const fetched = fetchResult.source
    for (const line of fetchResult.errors) {
      await appendLog(env, deployment_id, `⚠ ${line}`)
    }
    workerCode = fetched?.code ?? ''
    if (!fetched || !workerCode) {
      // Integrity failures are spelled out: the log has to say *why* nothing was
      // deployed, because a partial download is the exact failure this screen
      // exists for.
      const detail = fetchResult.errors.join(' · ').slice(0, 400)
      await appendLog(env, deployment_id, '✗ failed to fetch a verified worker source')
      await updateDeployment(env, deployment_id, 'failed', {
        error_message: detail ? `failed to fetch worker source: ${detail}` : 'failed to fetch worker source',
      })
      return
    }
    if (fetched.usedFallback) {
      await appendLog(env, deployment_id, `primary source unavailable, used fallback (${new URL(fetched.url).host})`)
    }
    await appendLog(
      env,
      deployment_id,
      `✓ worker source fetched (${workerCode.length} bytes)` +
        (fetched.checksumVerified
          ? ` — checksum verified against upstream ${fetched.commitSha?.slice(0, 8) ?? fetched.blobSha?.slice(0, 8) ?? ''}`
          : ' — local checks only (no published checksum for this copy)'),
    )
    if (fetched.note) await appendLog(env, deployment_id, `ℹ ${fetched.note}`)

    // The source is uploaded exactly as upstream publishes it. (The per-deployment
    // "obfuscated format" that used to rewrite it here is gone: it was
    // incompatible with the Cloudflare Workers runtime and made the platform
    // refuse to run the uploaded script.)
    const deployCode = workerCode

    await recordSourceFingerprint(env, deployment_id, {
      url: fetched.url,
      etag: fetched.etag,
      bytes: deployCode.length,
      sha256: fetched.sha256,
      commitSha: fetched.commitSha,
      blobSha: fetched.blobSha,
      checksumVerified: fetched.checksumVerified,
    })

    // ── Provision storage ────────────────────────────────────────────────
    // • zeus-style panels (zeus / miliconfigzeus / nova) get a D1 database;
    // • a source declaring `kvBinding` gets its KV namespace;
    // • an arbitrary GitHub repo gets exactly what the user ticked.
    let d1DatabaseId = ''
    let kvNamespaceId = ''
    const wantsD1 = sourceConfig.kind === 'zeus' || (sourceConfig.kind === 'github' && !!job.extra_bindings?.d1)
    // edgetunnel/CFnew cannot work without their namespace, so a failure there
    // fails the deployment; for panels and GitHub repos KV is optional.
    const kvRequired = kvBindingName !== '' && sourceConfig.kind !== 'zeus' && sourceConfig.kind !== 'github'
    if (wantsD1) {
      await appendLog(env, deployment_id, 'creating D1 database...')
      const d1Name = `${worker_name}-db`
      const d1Resp = await fetch(`${API_BASE}/accounts/${accountId}/d1/database`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: d1Name }),
      })
      const d1Data = (await d1Resp.json().catch(() => ({}))) as { success?: boolean; result?: { uuid?: string }; errors?: Array<{ message: string }> }
      d1DatabaseId = d1Data.result?.uuid ?? ''
      if (!d1DatabaseId) {
        // Already exists? Reuse it instead of failing.
        const listResp = await fetch(`${API_BASE}/accounts/${accountId}/d1/database?per_page=100`, { headers })
        const listData = (await listResp.json().catch(() => ({}))) as { result?: Array<{ uuid?: string; name?: string }> }
        d1DatabaseId = listData.result?.find((d) => d.name === d1Name)?.uuid ?? ''
      }
      if (!d1DatabaseId) {
        const msg = d1Data.errors?.[0]?.message ?? 'failed to create D1 database'
        await appendLog(env, deployment_id, `✗ ${msg}`)
        await updateDeployment(env, deployment_id, 'failed', { error_message: msg })
        return
      }
      await appendLog(env, deployment_id, `✓ D1 database ready: ${d1DatabaseId.slice(0, 8)}...`)
    }
    if (kvBindingName) {
      // Panels like nova need KV next to their D1 database; the classic
      // KV-backed workers need it alone. One code path for both.
      await appendLog(env, deployment_id, 'creating KV namespace...')
      const kvResp = await fetch(`${API_BASE}/accounts/${accountId}/storage/kv/namespaces`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `${worker_name}-kv` }),
      })
      const kvData = (await kvResp.json()) as { success?: boolean; result?: { id: string }; errors?: Array<{ message: string }> }
      if (kvData.success && kvData.result?.id) {
        kvNamespaceId = kvData.result.id
        await appendLog(env, deployment_id, `✓ KV namespace created: ${kvNamespaceId.slice(0, 8)}...`)
      } else if (kvRequired) {
        const msg = kvData.errors?.[0]?.message ?? 'failed to create KV namespace'
        await appendLog(env, deployment_id, `✗ ${msg}`)
        await updateDeployment(env, deployment_id, 'failed', { error_message: msg })
        return
      } else {
        await appendLog(env, deployment_id, `⚠ KV namespace unavailable (${kvData.errors?.[0]?.message ?? 'no permission'}) — continuing without KV`)
      }
    }

    // ── Provision R2 bucket (free tier: 10 GB + zero egress) ────────────
    // Bound as R2 on every deployed worker — heavy data (logs, scan results,
    // IP lists, sub caches) can live here instead of slowing D1/KV down.
    // Non-fatal: if the token lacks R2 permission we just log and continue.
    let r2BucketName = ''
    await appendLog(env, deployment_id, 'creating R2 bucket...')
    const r2Name = `${worker_name}-r2`
    const r2Resp = await fetch(`${API_BASE}/accounts/${accountId}/r2/buckets`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: r2Name }),
    })
    const r2Data = (await r2Resp.json().catch(() => ({}))) as { success?: boolean; result?: { name?: string }; errors?: Array<{ message: string }> }
    if (r2Data.success && r2Data.result?.name) {
      r2BucketName = r2Data.result.name
      await appendLog(env, deployment_id, `✓ R2 bucket created: ${r2BucketName} (free tier)`)
    } else {
      // Already exists? Reuse it.
      const r2ListResp = await fetch(`${API_BASE}/accounts/${accountId}/r2/buckets?per_page=100`, { headers })
      const r2ListData = (await r2ListResp.json().catch(() => ({}))) as { result?: { buckets?: Array<{ name?: string }> } }
      r2BucketName = r2ListData.result?.buckets?.find((b) => b.name === r2Name)?.name ?? ''
      if (r2BucketName) {
        await appendLog(env, deployment_id, `✓ R2 bucket reused: ${r2BucketName}`)
      } else {
        await appendLog(env, deployment_id, `⚠ R2 bucket unavailable (${r2Data.errors?.[0]?.message ?? 'no permission'}) — continuing without R2`)
      }
    }

    // ── Write initial config to KV (KV sources only; zeus self-manages) ─
    let initialConfig: Record<string, unknown>
    const addTxtKey = 'ADD.txt'

    // Panel path for edgetunnel: the custom path if set, otherwise always
    // /admin so the panel address is predictable and ends with /admin.
    const panelPath = custom_path
      ? (custom_path.startsWith('/') ? custom_path : '/' + custom_path)
      : '/admin'

    if (sourceConfig.kind === 'github') {
      // An arbitrary GitHub repo has its own configuration scheme (env vars,
      // its own KV keys) which we cannot know, so nothing is seeded and no KV
      // value is written. The deploy log says so rather than pretending a
      // config was written to a namespace that may not even exist.
      initialConfig = {}
      await appendLog(
        env,
        deployment_id,
        'ℹ منبع GitHub: پیکربندی اولیه نوشته نشد — کانفیگ را در خود پنل/اپ ورکر تنظیم کنید.',
      )
    } else if (sourceConfig.kind === 'zeus') {
      // Pre-create the panel's D1 schema through the API instead of leaving it
      // to the worker's first request: a brand-new database + a cold isolate
      // racing its own ensureSchema is exactly what produced the immediate
      // `error code: 1101` right after deploy. Non-fatal — the panel still
      // self-initializes on first request if this step fails.
      await appendLog(env, deployment_id, 'seeding zeus D1 schema (users/settings tables)…')
      const seeded = await seedZeusSchema(API_BASE, accountId, d1DatabaseId, headers)
      await appendLog(
        env,
        deployment_id,
        `✓ zeus D1 schema ready (${seeded.ok} statements applied${seeded.failed ? `, ${seeded.failed} already present/skipped` : ''})`,
      )
    } else {

    if (sourceConfig.kind === 'nexus') {
      // NEXUS merges over its own defaults — just seed identity + proxyip.
      initialConfig = { name: 'NEXUS', lang: 'fa', theme: 'dark', uuid, p: proxyip || '' }
    } else if (configFormat === 'custom') {
      initialConfig = {
        wk: '', ev: 'yes', et: 'no', ex: 'no', ech: 'no', tp: '',
        customDNS: 'https://223.5.5.5/dns-query',
        customECHDomain: 'cloudflare-ech.com',
        alpn: '', d: custom_path || '', p: proxyip || '', yx: '', yxURL: '', s: '', homepage: '',
        scu: 'https://url.v1.mk/sub', ena: 'no', epd: 'yes', epi: 'yes', egi: 'yes',
        ae: '', rm: '', qj: '', dkby: 'no', yxby: '',
        ipv4: 'yes', ipv6: 'yes', ispMobile: 'yes', ispUnicom: 'yes', ispTelecom: 'yes',
      }
    } else {
      initialConfig = {
        UUID: uuid,
        HOST: '',
        HOSTS: [],
        PATH: panelPath,
        协议类型: 'vless',
        传输协议: 'ws',
        gRPC模式: 'gun',
        gRPCUserAgent: 'Mozilla/5.0',
        跳过证书验证: false,
        启用0RTT: false,
        TLS分片: null,
        随机路径: false,
        ECH: false,
        ECHConfig: { DNS: 'https://dns.alidns.com/dns-query', SNI: 'cloudflare-ech.com' },
        SS: { 加密方式: 'aes-128-gcm', TLS: true },
        Fingerprint: 'chrome',
        优选订阅生成: {
          local: true,
          本地IP库: { 随机IP: true, 随机数量: 16, 指定端口: -1 },
          SUB: null,
          SUBNAME: 'edgetunnel',
          SUBUpdateTime: 3,
          TOKEN: '',
        },
        订阅转换配置: {
          SUBAPI: 'https://subapi.edt-pages.workers.dev',
          SUBCONFIG: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/main/Clash/config/ACL4SSR_Online_Mini_MultiMode.ini',
          SUBEMOJI: false, SUBLIST: false, UDP: false, XUDP: false, TLS13: false, APPEND_TYPE: false, SORT: false,
        },
        反代: {
          proxyip: proxyip || 'auto',
          SOCKS5: { 启用: null, 全局: false, 账号: '', 白名单: [] },
          路径模板: {},
        },
        TG: { 启用: false, BotToken: null, ChatID: null },
        CF: { Email: null, GlobalAPIKey: null, AccountID: null, APIToken: null, UsageAPI: null, Usage: { success: false, pages: 0, workers: 0, total: 0, max: 100000 } },
      }
    }

    await fetch(`${API_BASE}/accounts/${accountId}/storage/kv/namespaces/${kvNamespaceId}/values/${configKvKey}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(initialConfig, null, 2),
    }).catch(() => null)
    await appendLog(env, deployment_id, `✓ initial config written to KV (${configKvKey})`)

    await fetch(`${API_BASE}/accounts/${accountId}/storage/kv/namespaces/${kvNamespaceId}/values/${addTxtKey}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'text/plain' },
      body: proxyip || '',
    }).catch(() => null)
    } // end non-zeus KV seeding

    let workerUrl: string
    /** Account workers.dev subdomain — empty when it could not be resolved. */
    let workersSubdomain = ''
    // edgetunnel: panel lives at the panel path (login page asking for the
    // password) — custom path or /admin by default.
    // Default (custom) worker: UUID is always part of the URL and bypasses
    // the login page entirely.
    // Zeus: the whole worker IS the admin panel (root URL, own login).
    const panelKey = sourceConfig.kind === 'zeus' ? '' : configFormat === 'edgetunnel' ? panelPath.slice(1) : uuid

    if (method === 'workers') {
      // ── Upload worker script ──────────────────────────────────────────
      await appendLog(env, deployment_id, 'uploading worker script...')
      const meta = {
        main_module: 'worker.js',
        compatibility_date: compatDate,
        compatibility_flags: sourceConfig.compatFlags ?? ['nodejs_compat', 'global_fetch_strictly_public'],
        bindings: sourceConfig.kind === 'github' ? [
          // Arbitrary repo: bind exactly what the user asked for, nothing more.
          ...(kvNamespaceId ? [{ type: 'kv_namespace', name: 'KV', namespace_id: kvNamespaceId }] : []),
          ...(d1DatabaseId ? [{ type: 'd1', name: 'DB', id: d1DatabaseId }] : []),
          ...(r2BucketName ? [{ type: 'r2_bucket', name: 'R2', bucket_name: r2BucketName }] : []),
          { type: 'plain_text', name: 'WORKER_NAME', text: worker_name },
          { type: 'plain_text', name: 'WIZARD_URL', text: job.origin },
        ] : sourceConfig.kind === 'zeus' ? [
          // Zeus-style full panels (zeus, nova) need D1; nova also binds the
          // KV namespace declared on its source entry (kvBinding !== '').
          { type: 'd1', name: 'DB', id: d1DatabaseId },
          ...(kvBindingName ? [{ type: 'kv_namespace', name: kvBindingName, namespace_id: kvNamespaceId }] : []),
          ...(r2BucketName ? [{ type: 'r2_bucket', name: 'R2', bucket_name: r2BucketName }] : []),
          { type: 'plain_text', name: 'CF_API_TOKEN', text: cf_token },
          { type: 'plain_text', name: 'CF_ACCOUNT_ID', text: accountId },
          { type: 'plain_text', name: 'WORKER_NAME', text: worker_name },
          { type: 'plain_text', name: 'WIZARD_URL', text: job.origin },
        ] : [
          { type: 'kv_namespace', name: kvBindingName, namespace_id: kvNamespaceId },
          ...(r2BucketName ? [{ type: 'r2_bucket', name: 'R2', bucket_name: r2BucketName }] : []),
          // A source without a UUID variable must not emit a binding with an
          // empty name — Cloudflare rejects the whole upload for it.
          ...(uuidEnv ? [{ type: 'plain_text', name: uuidEnv, text: uuid }] : []),
          ...(configFormat === 'edgetunnel' ? [
            { type: 'plain_text', name: 'PATH', text: panelPath },
            { type: 'plain_text', name: 'PROXYIP', text: proxyip },
            ...(admin_password ? [{ type: 'plain_text', name: 'ADMIN', text: admin_password }] : []),
          ] : sourceConfig.kind === 'nexus' ? [] : [
            { type: 'plain_text', name: 'P', text: proxyip },
          ]),
        ],
      }

      // A 404 here means this deployment creates the script instead of updating one.
      const scriptExists = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}`, { headers })
        .then((r) => r.ok)
        .catch(() => true)

      const uploadForm = () => {
        const form = new FormData()
        form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }))
        form.append('worker.js', new Blob([deployCode], { type: 'application/javascript+module' }), 'worker.js')
        return form
      }

      const uploadResp = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}`, {
        method: 'PUT', headers, body: uploadForm(),
      })
      const uploadData = (await uploadResp.json()) as { success?: boolean; errors?: Array<{ message: string }> }
      if (!uploadData.success) {
        const msg = uploadData.errors?.[0]?.message ?? 'failed to upload worker'
        await appendLog(env, deployment_id, `✗ ${msg}`)
        await updateDeployment(env, deployment_id, 'failed', { error_message: msg })
        return
      }
      await appendLog(env, deployment_id, '✓ worker script uploaded')

      // ── Make a brand-new script actually stay live ──────────────────────
      // Cloudflare leaves a *first* creation in a state where the script serves
      // for a few seconds and then flips permanently into `error code: 1101`:
      // every later request fails before the script runs (no invocation is
      // logged) and it never recovers. Reproduced on two accounts, with three
      // sources and with both upload APIs, so it belongs to the platform's
      // first-creation path — not to the script being uploaded. Deleting the
      // just-created script and immediately re-creating it with the same bytes
      // and bindings is stable (verified live for minutes where the single
      // upload died within 10 s), and a script that did not exist a moment ago
      // costs nothing to delete. An already existing script is left untouched:
      // deleting it would drop its routes and custom domains.
      if (!scriptExists) {
        await appendLog(env, deployment_id, 're-creating the new script (Cloudflare can leave a first creation dead)…')
        await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}`, { method: 'DELETE', headers })
          .catch(() => null)
        const recreateResp = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}`, {
          method: 'PUT', headers, body: uploadForm(),
        })
        const recreateData = (await recreateResp.json().catch(() => ({}))) as { success?: boolean; errors?: Array<{ message: string }> }
        await appendLog(env, deployment_id, recreateData.success
          ? '✓ script re-created cleanly'
          : `⚠ re-create failed: ${recreateData.errors?.[0]?.message ?? 'unknown error'}`)
      }

      // ── Enable workers.dev route (with the original fallbacks) ────────
      await appendLog(env, deployment_id, 'enabling workers.dev route for script...')
      const subdomainResp = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}/subdomain`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
      const subdomainResult = (await subdomainResp.json().catch(() => ({}))) as { success?: boolean; errors?: Array<{ message: string }> }
      if (subdomainResult.success) {
        await appendLog(env, deployment_id, '✓ workers.dev route enabled')
      } else {
        await appendLog(env, deployment_id, `⚠ workers.dev route: ${subdomainResult.errors?.[0]?.message ?? 'unknown error'} — trying account subdomain...`)
        const existingSub = await fetch(`${API_BASE}/accounts/${accountId}/workers/subdomain`, { headers })
        const existingSubData = (await existingSub.json().catch(() => ({}))) as { result?: { subdomain?: string } }
        if (!existingSubData.result?.subdomain) {
          const subName = `edge-${worker_name}`.replace(/[^a-z0-9-]/g, '').slice(0, 30)
          await fetch(`${API_BASE}/accounts/${accountId}/workers/subdomain`, {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ subdomain: subName }),
          }).catch(() => null)
          await appendLog(env, deployment_id, `✓ account subdomain set: ${subName}`)
        }
        await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}/subdomain`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        }).catch(() => null)
      }

      // ── Script settings: keep the workers.dev route, defer Smart Placement ─
      // `placements: [{ mode: 'smart' }]` was applied here *immediately* after
      // the first upload of a brand-new script. Cloudflare has to re-place the
      // isolate when smart placement is toggled on, and doing it in the same
      // second as creation is what made the very first requests die with
      // `error code: 1101` (the panel's own D1-backed sources — zeus — hit it
      // every deploy; KV sources like clmu never did). The fix: only confirm
      // the route now, then warm the worker up and enable smart placement
      // afterwards, once the script actually answers.
      const settingsResp = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}/settings`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workers_dev: true, preview_version_id: null }),
      }).catch(() => null)
      await appendLog(env, deployment_id, settingsResp?.ok
        ? '✓ workers.dev route confirmed (Smart Placement deferred until the worker answers)'
        : '⚠ workers.dev route confirm failed — continuing')

      // ── Enable gRPC + WebSockets on all zones of the account ───────────
      // Required for gRPC transport nodes to pass through Cloudflare without
      // conflicts. XHTTP needs no zone switch (plain HTTP/2 streams), but
      // WebSockets must be ON for ws/xhttp fallbacks. Non-fatal per zone.
      try {
        const zonesResp = await fetch(`${API_BASE}/zones?per_page=50`, { headers })
        const zonesData = (await zonesResp.json().catch(() => ({}))) as { success?: boolean; result?: Array<{ id: string; name: string }> }
        const zones = zonesData.result ?? []
        if (zones.length === 0) {
          await appendLog(env, deployment_id, 'ℹ no zones on token — workers.dev only (gRPC works natively there)')
        }
        for (const zone of zones) {
          const grpcResp = await fetch(`${API_BASE}/zones/${zone.id}/settings/grpc`, {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: 'on' }),
          }).catch(() => null)
          const wsResp = await fetch(`${API_BASE}/zones/${zone.id}/settings/websockets`, {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: 'on' }),
          }).catch(() => null)
          const okGrpc = grpcResp?.ok ?? false
          const okWs = wsResp?.ok ?? false
          await appendLog(env, deployment_id, `${okGrpc && okWs ? '✓' : '⚠'} zone ${zone.name}: gRPC ${okGrpc ? 'ON' : 'skip (permission?)'} · WebSockets ${okWs ? 'ON' : 'skip'}`)
        }
      } catch {
        await appendLog(env, deployment_id, '⚠ zone settings step skipped (no zone access)')
      }

      // ── Read workers.dev subdomain & build final URL ──────────────────
      await appendLog(env, deployment_id, 'reading workers.dev subdomain...')
      workersSubdomain = await resolveWorkersSubdomain(env, accountId, headers, worker_name)
      workerUrl = workersSubdomain
        ? `https://${worker_name}.${workersSubdomain}.workers.dev`
        : `https://${worker_name}.workers.dev`
      await appendLog(env, deployment_id, `✓ worker URL: ${workerUrl}`)
      if (!workersSubdomain) {
        await appendLog(
          env,
          deployment_id,
          '⚠ زیردامنهٔ workers.dev این حساب خوانده نشد، پس آدرس بالا کامل نیست (فقط نام ورکر است). توکن را با دسترسی Workers Scripts:Read بازسازی کنید یا یک Custom Domain به این ورکر وصل کنید تا آدرس و لینک‌ها درست شوند.',
        )
      }
    } else {
      // ── Pages deployment (original flow) ──────────────────────────────
      await appendLog(env, deployment_id, 'creating Pages project...')
      await fetch(`${API_BASE}/accounts/${accountId}/pages/projects`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: worker_name, production_branch: 'main' }),
      }).catch(() => null)

      await appendLog(env, deployment_id, 'binding KV & variables to project...')
      const cfg = {
        deployment_configs: {
          production: {
            compatibility_date: compatDate,
            compatibility_flags: sourceConfig.compatFlags ?? ['nodejs_compat', 'global_fetch_strictly_public'],
            ...(kvNamespaceId ? { kv_namespaces: { [kvBindingName]: { namespace_id: kvNamespaceId } } } : {}),
            ...(r2BucketName ? { r2_buckets: { R2: { bucket_name: r2BucketName } } } : {}),
            environment_variables: configFormat === 'edgetunnel' ? {
              ...(uuidEnv ? { [uuidEnv]: { value: uuid, type: 'plain_text' } } : {}),
              PATH: { value: panelPath, type: 'plain_text' },
              PROXYIP: { value: proxyip, type: 'plain_text' },
              ...(admin_password ? { ADMIN: { value: admin_password, type: 'plain_text' } } : {}),
            } : {
              ...(uuidEnv ? { [uuidEnv]: { value: uuid, type: 'plain_text' } } : {}),
              ...(sourceConfig.kind === 'nexus' ? {} : { P: { value: proxyip, type: 'plain_text' } }),
            },
          },
        },
      }
      await fetch(`${API_BASE}/accounts/${accountId}/pages/projects/${worker_name}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      }).catch(() => null)

      await appendLog(env, deployment_id, 'uploading _worker.js deployment...')
      const pagesFd = new FormData()
      pagesFd.append('_worker.js', new Blob([deployCode], { type: 'application/javascript' }), '_worker.js')
      pagesFd.append('branch', 'main')
      const pagesDepResp = await fetch(
        `${API_BASE}/accounts/${accountId}/pages/projects/${worker_name}/deployments`,
        { method: 'POST', headers, body: pagesFd },
      )
      let pagesDepData: { result?: { url?: string } } = {}
      try {
        pagesDepData = (await pagesDepResp.json()) as { result?: { url?: string } }
      } catch {
        // Non-fatal — predictable *.pages.dev URL below.
      }
      workerUrl = pagesDepData.result?.url ?? `https://${worker_name}.pages.dev`
      await appendLog(env, deployment_id, `✓ Pages URL: ${workerUrl}`)

      await updateDeployment(env, deployment_id, 'deployed', {
        worker_url: workerUrl,
        kv_namespace_id: kvNamespaceId,
        cf_account_id: accountId,
        worker_source: worker_source,
      })
    }

    // ── Build the links the UI shows ────────────────────────────────────
    //
    // These differ per source and were previously computed from one wrong
    // guess: a fixed `/admin` (edgetunnel) or `/<uuid>` (CFnew) for EVERY
    // worker. That produced a 403 "UUID wrong" page for edgetunnel, a 404 for
    // zeus (`/<uuid>` does not exist there) and a `/sub` link that returned
    // the origin's 404 page. Each source is now spelled out exactly.
    const base = workerUrl.replace(/\/+$/, '')
    const customPath = (custom_path ?? '').trim()
    let panelUrl: string
    let subUrl: string
    if (sourceConfig.kind === 'edgetunnel') {
      // The dashboard is fixed at /admin (redirects to /login until the admin
      // password is entered); it never moves with a custom path.
      panelUrl = `${base}/admin`
      // The sub link needs the same md5(host+uuid) token the worker checks,
      // otherwise /sub falls through to the upstream 404 page.
      let token = ''
      try { token = await edgetunnelSubToken(new URL(base).host, uuid) } catch { /* best effort */ }
      subUrl = token ? `${base}/sub?token=${token}` : `${base}/sub`
    } else if (sourceConfig.kind === 'github') {
      // An arbitrary repository: its own app decides its routes, so the worker
      // root is the only address we can promise — and there is no deploy-time
      // sub link we could build for an unknown app.
      panelUrl = base
      subUrl = ''
    } else if (sourceConfig.kind === 'zeus') {
      // Zeus-style full panels (zeus + nova): the whole worker IS a
      // self-contained admin panel. Zeus serves its dashboard at the root;
      // Nova's is fixed at /admin (first visit shows the setup wizard) and a
      // subscription only exists after a user is created inside the panel,
      // so there is no deploy-time sub link for either.
      panelUrl = worker_source === 'nova' ? `${base}/admin` : base
      subUrl = ''
    } else {
      // CFnew-style workers (custom + NEXUS): the UUID path IS the dashboard
      // and its sub link — there is nothing at `/sub` on the root. When the
      // user set a custom path (`d`), the UUID path is disabled and the
      // dashboard/sub live under that path instead.
      const custom = customPath.replace(/^\/+|\/+$/g, '')
      if (custom) {
        panelUrl = `${base}/${custom}`
        subUrl = `${base}/${custom}/sub`
      } else {
        panelUrl = `${base}/${uuid}`
        subUrl = `${base}/${uuid}/sub`
      }
    }
    await appendLog(env, deployment_id, `✓ panel URL: ${panelUrl}`)
    if (subUrl) await appendLog(env, deployment_id, `✓ sub URL: ${subUrl}`)
    else await appendLog(env, deployment_id, 'ℹ این پنل لینک ساب آماده ندارد — داخل پنل کاربر بسازید')
    if (sourceConfig.kind === 'zeus' && /\.workers\.dev\//i.test(`${panelUrl}/`)) {
      // Ping/کانفیگ روی workers.dev بدون فیلترشکن در ایران جواب نمی‌دهد چون
      // خودِ دامنهٔ *.workers.dev سانسور شده است — نه ورکر و نه کانفیگ ایرادی
      // ندارند. راه‌حل: وصل کردن دامنهٔ شخصی (Custom Domain) به ورکر.
      await appendLog(
        env,
        deployment_id,
        '💡 پینگ/ساب روی دامنهٔ workers.dev بدون فیلترشکن کار نمی‌کند چون *.workers.dev در ایران مسدود است. از تنظیمات Cloudflare یک Custom Domain (دامنهٔ شخصی) برای این ورکر فعال کنید؛ آدرس پنل و ساب با دامنهٔ شخصی بدون فیلترشکن هم در دسترس است.',
      )
    }
    // ── Persist the result BEFORE anything optional ─────────────────────
    // The whole deployment runs as a `waitUntil` background task, and the
    // runtime only guarantees a short window after the response: a long tail
    // step (the old warm-up could poll for 190s) gets the task killed midway.
    // The row then stayed on 'deploying' forever and the user never saw the
    // link — even though the worker itself was already up. Writing status,
    // worker URL and both links here means the live log the SPA polls shows the
    // finished deployment immediately, and the self-check below can only ever
    // decorate it.
    await updateDeployment(env, deployment_id, 'deployed', {
      worker_url: workerUrl,
      panel_url: panelUrl,
      sub_url: subUrl || null,
      kv_namespace_id: kvNamespaceId,
      cf_account_id: accountId,
      route: null,
      worker_source: worker_source,
    })

    // ── Optional self-check tail (workers only) ────────────────────────
    // Proves the script really executes (a fresh worker answers `error code:
    // 1101` for its first seconds) and only then turns on Smart Placement.
    // Bounded by waitForWorkerLive's total budget so it can never hold the
    // deployment open.
    if (method === 'workers' && workersSubdomain) {
      const isZeus = sourceConfig.kind === 'zeus'
      await appendLog(env, deployment_id, 'warming up worker (waiting for first live response)…')
      const alive = await waitForWorkerLive(workerUrl, isZeus ? 8 : 4, 1200)
      await patchDeploymentConfig(env, deployment_id, {
        self_check: alive ? 'passed' : 'failed',
        self_check_at: nowIso(),
      })
      if (alive) {
        await appendLog(env, deployment_id, '✓ worker is live — first request answered without 1101')
        // These bytes are known to run: remember them as the rollback target.
        await recordSourceFingerprint(env, deployment_id, {
          url: fetched.url,
          etag: fetched.etag,
          bytes: deployCode.length,
          sha256: fetched.sha256,
          commitSha: fetched.commitSha,
          blobSha: fetched.blobSha,
          checksumVerified: fetched.checksumVerified,
          markGood: true,
        })
      } else {
        await appendLog(
          env,
          deployment_id,
          '⚠ worker هنوز پاسخ زنده نداد (warm-up) — ورکر ساخته شده و لینک‌هایش بالاست؛ اگر بعد از چند دقیقه هم بالا نیامد، یک دامنهٔ شخصی (Custom Domain) وصل کنید یا از /recover استفاده کنید.',
        )
      }

      // Smart Placement now — after the script has executed at least once.
      await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}/settings`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ placements: [{ mode: 'smart' }] }),
      }).catch(() => null)
      await appendLog(env, deployment_id, '✓ Smart Placement ON (worker co-located with D1)')
    } else if (method === 'workers') {
      await appendLog(
        env,
        deployment_id,
        'ℹ self-check skipped — بدون زیردامنهٔ workers.dev آدرس ورکر قابل تست نیست (ورکر مستقر شده و لینک پنل بالاست).',
      )
    }

    await appendLog(env, deployment_id, '✓ deployment complete!')

    // Bookkeeping: token usage + activity log
    if (job.cf_token_row_id) {
      await env.DB.prepare('UPDATE cf_tokens SET last_used_at = ? WHERE id = ?').bind(nowIso(), job.cf_token_row_id).run()
    }
    const depRow = await env.DB.prepare('SELECT user_id, name FROM deployments WHERE id = ?')
      .bind(deployment_id)
      .first<{ user_id: string; name: string }>()
    if (depRow) {
      await env.DB.prepare(
        'INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(genId(), depRow.user_id, 'deployment_deployed', 'deployment', depRow.name, nowIso())
        .run()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    await appendLog(env, deployment_id, `✗ ${msg}`)
    await updateDeployment(env, deployment_id, 'failed', { error_message: msg })
  } finally {
    // Telegram notification (never blocks or breaks the deployment flow).
    const row = await env.DB.prepare('SELECT user_id, name, status, worker_url, panel_url, error_message FROM deployments WHERE id = ?')
      .bind(deployment_id)
      .first<{ user_id: string; name: string; status: string; worker_url: string | null; panel_url: string | null; error_message: string | null }>()
    if (row && (row.status === 'deployed' || row.status === 'failed')) {
      await notifyDeployment(env, row.user_id, row.name, row.status as 'deployed' | 'failed', row.worker_url, row.panel_url, row.error_message)
        .catch(() => null)
    }
  }
}
