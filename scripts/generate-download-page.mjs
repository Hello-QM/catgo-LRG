#!/usr/bin/env node

import {
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  classifyDownloadAsset,
  comparePlatformDownloads,
} from './download-asset-classifier.mjs'

export const TESTFLIGHT_URL = 'https://testflight.apple.com/join/FdHup5Hz'

const PLATFORM_META = {
  windows: {
    code: 'WIN',
    name: 'Windows',
    architecture: 'x64',
    noteZh: '推荐 EXE 安装器；企业部署也可选 MSI。',
    noteEn: 'EXE recommended; MSI is also available for managed installs.',
  },
  macos: {
    code: 'MAC',
    name: 'macOS',
    architecture: 'Apple Silicon',
    noteZh: '适用于 Apple Silicon，下载 DMG 后拖入应用程序。',
    noteEn: 'For Apple Silicon. Open the DMG and drag CatGo to Applications.',
  },
  linux: {
    code: 'LNX',
    name: 'Linux',
    architecture: 'amd64',
    noteZh: '按发行版选择 DEB、RPM 或 AppImage。',
    noteEn: 'Choose DEB, RPM, or AppImage for your distribution.',
  },
  android: {
    code: 'APK',
    name: 'Android',
    architecture: 'Universal',
    noteZh: '通用签名 APK；系统可能要求允许安装未知应用。',
    noteEn: 'Signed universal APK; Android may request install permission.',
  },
  ios: {
    code: 'IOS',
    name: 'iOS',
    architecture: 'iPhone / iPad',
    noteZh: '通过 Apple TestFlight 安装公开测试版。',
    noteEn: 'Install the public beta through Apple TestFlight.',
  },
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value))
}

function validateReleaseTag(tag) {
  if (
    typeof tag !== 'string'
    || tag !== tag.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)
  ) {
    throw new Error(`Invalid release tag: ${JSON.stringify(tag)}`)
  }
  return tag
}

function normalizeBaseUrl(baseUrl) {
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('Download base URL must be a valid HTTPS URL')
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('Download base URL must be a clean HTTPS URL')
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.href.replace(/\/$/, '')
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`
}

function normalizeAsset(asset, tag, baseUrl) {
  if (
    !asset
    || typeof asset.name !== 'string'
    || asset.name.length === 0
    || !Number.isFinite(asset.size)
    || asset.size < 0
  ) {
    throw new Error('Every release asset must have a non-empty name and size')
  }
  const classification = classifyDownloadAsset(asset.name)
  return {
    name: asset.name,
    size: asset.size,
    sizeLabel: formatBytes(asset.size),
    ...classification,
    url: `${baseUrl}/${encodePathSegment(tag)}/${encodePathSegment(asset.name)}`,
  }
}

export function buildReleaseModel({ assets, tag, baseUrl }) {
  if (!Array.isArray(assets)) {
    throw new Error('Release assets must be an array')
  }
  const safeTag = validateReleaseTag(tag)
  const safeBaseUrl = normalizeBaseUrl(baseUrl)
  const normalizedAssets = assets
    .map((asset) => normalizeAsset(asset, safeTag, safeBaseUrl))
    .sort((left, right) => left.name.localeCompare(right.name))

  const platforms = Object.fromEntries(
    Object.entries(PLATFORM_META).map(([key, meta]) => [
      key,
      {
        ...meta,
        key,
        available: false,
        downloads: [],
        preferred: null,
      },
    ]),
  )
  const other = []

  for (const asset of normalizedAssets) {
    if (asset.userFacing) {
      platforms[asset.platform].downloads.push(asset)
    } else {
      other.push(asset)
    }
  }

  for (const [key, platform] of Object.entries(platforms)) {
    if (key === 'ios') continue
    platform.downloads.sort((left, right) =>
      comparePlatformDownloads(key, left, right),
    )
    platform.preferred = platform.downloads[0] ?? null
    platform.available = platform.preferred !== null
  }

  const testFlightAsset = {
    name: 'Apple TestFlight',
    size: null,
    sizeLabel: 'Apple',
    format: 'TestFlight',
    platform: 'ios',
    architecture: PLATFORM_META.ios.architecture,
    url: TESTFLIGHT_URL,
  }
  platforms.ios.downloads = [testFlightAsset]
  platforms.ios.preferred = testFlightAsset
  platforms.ios.available = true

  return {
    tag: safeTag,
    version: safeTag.replace(/^v/i, ''),
    baseUrl: safeBaseUrl,
    platforms,
    other,
  }
}

function renderPlatformTab(platform) {
  return `
        <a class="platform-tab" data-platform="${platform.key}" href="#platform-${platform.key}">
          <span class="platform-code">${platform.code}</span>
          <span>${escapeHtml(platform.name)}</span>
        </a>`
}

function renderDownloadLink(asset, { primary = false } = {}) {
  const label = primary
    ? `下载 ${asset.format} · Download`
    : `${asset.format} · ${asset.sizeLabel}`
  return `
              <a class="${primary ? 'download-primary' : 'download-alt'}"
                 href="${escapeHtml(asset.url)}"
                 ${asset.format === 'TestFlight' ? 'rel="noopener"' : 'download'}>
                ${escapeHtml(label)}
              </a>`
}

function renderPlatformCard(platform) {
  const downloads = platform.available
    ? `
          <div class="download-actions">
            ${renderDownloadLink(platform.preferred, { primary: true })}
            ${
              platform.downloads
                .slice(1)
                .map((asset) => renderDownloadLink(asset))
                .join('')
            }
          </div>
          <p class="asset-facts">
            ${escapeHtml(platform.preferred.architecture)}
            <span aria-hidden="true">·</span>
            ${escapeHtml(platform.preferred.sizeLabel)}
          </p>`
    : `
          <div class="unavailable" role="status">
            构建暂未提供
            <span>Build not available yet</span>
            <a class="other-jump" href="#other-downloads">
              查看其他下载 · See other downloads
            </a>
          </div>`

  return `
      <article class="platform-card" id="platform-${platform.key}" data-platform="${platform.key}">
        <div class="card-topline">
          <span class="platform-code">${platform.code}</span>
          <span class="availability ${platform.available ? 'available' : ''}">
            ${platform.available ? 'AVAILABLE' : 'PENDING'}
          </span>
        </div>
        <h3>${escapeHtml(platform.name)}</h3>
        <p class="architecture">${escapeHtml(platform.architecture)}</p>
        <p class="install-note">
          ${escapeHtml(platform.noteZh)}
          <span>${escapeHtml(platform.noteEn)}</span>
        </p>
        ${downloads}
      </article>`
}

function renderOtherDownloads(assets) {
  if (assets.length === 0) {
    return `
          <p class="other-empty">
            当前版本没有附加文件。 / No additional files in this release.
          </p>`
  }
  return `
          <div class="other-list">
            ${assets
              .map(
                (asset) => `
            <a class="other-row" href="${escapeHtml(asset.url)}" download>
              <span class="other-name">${escapeHtml(asset.name)}</span>
              <span class="other-size">${escapeHtml(asset.sizeLabel)}</span>
              <span class="other-action">下载 ↓</span>
            </a>`,
              )
              .join('')}
          </div>`
}

export function renderDownloadPage(model) {
  if (
    !model
    || typeof model.tag !== 'string'
    || !model.platforms
    || !Array.isArray(model.other)
  ) {
    throw new Error('A valid release model is required')
  }

  const platformList = Object.values(model.platforms)
  const availableCount = platformList.filter(
    (platform) => platform.available,
  ).length

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta name="description" content="CatGo ${escapeHtml(model.tag)} 中国大陆下载镜像 / China download mirror">
  <title>CatGo ${escapeHtml(model.tag)} 下载中心 / Download Hub</title>
  <style>
    :root {
      color-scheme: dark;
      --ink-950: #06101a;
      --ink-900: #091725;
      --ink-850: #0c1c2b;
      --ink-700: #23394a;
      --paper: #f6f2e8;
      --paper-deep: #e9e4d8;
      --graphite: #17242d;
      --muted: #61717a;
      --line: #d4d1c8;
      --copper: #bd5727;
      --copper-bright: #e4814b;
      --green: #7dd6b2;
      --focus: #54b7ff;
      --radius: 16px;
      --shadow: 0 18px 55px rgb(2 12 20 / 16%);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
        "Segoe UI", "Noto Sans SC", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    html {
      scroll-behavior: smooth;
      background: var(--ink-950);
    }

    body {
      margin: 0;
      color: var(--paper);
      background: var(--ink-950);
      min-width: 280px;
    }

    a {
      color: inherit;
    }

    a:focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 4px;
    }

    .skip-link {
      position: fixed;
      z-index: 20;
      top: 12px;
      left: 12px;
      padding: 10px 14px;
      border-radius: 8px;
      color: var(--ink-950);
      background: var(--paper);
      transform: translateY(-160%);
      transition: transform 160ms ease;
    }

    .skip-link:focus {
      transform: translateY(0);
    }

    .shell {
      width: min(1280px, calc(100% - 40px));
      margin: 0 auto;
    }

    .topbar {
      min-height: 78px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      font-weight: 720;
      letter-spacing: -0.02em;
    }

    .brand-mark {
      width: 32px;
      height: 32px;
      border-radius: 10px;
      background:
        radial-gradient(circle at 68% 32%, #f4bc92 0 4px, transparent 5px),
        linear-gradient(145deg, var(--copper-bright), var(--copper));
      box-shadow: inset 0 0 0 1px rgb(255 255 255 / 18%);
    }

    .mirror-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border: 1px solid #28584f;
      border-radius: 999px;
      color: var(--green);
      background: #10262b;
      font-size: 12px;
      white-space: nowrap;
    }

    .mirror-status::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 0 4px rgb(125 214 178 / 12%);
    }

    .hero {
      position: relative;
      overflow: hidden;
      padding: 72px 0 66px;
      background:
        linear-gradient(90deg, transparent 0 49.8%, rgb(255 255 255 / 4%) 50%, transparent 50.2%),
        linear-gradient(0deg, transparent 0 49.8%, rgb(255 255 255 / 4%) 50%, transparent 50.2%),
        var(--ink-900);
      background-size: 54px 54px;
      border-block: 1px solid rgb(255 255 255 / 5%);
    }

    .hero::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: radial-gradient(circle at 82% 45%, rgb(189 87 39 / 24%), transparent 28%);
    }

    .hero-grid {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: minmax(0, 1.6fr) minmax(280px, 0.7fr);
      gap: clamp(42px, 7vw, 100px);
      align-items: center;
    }

    .eyebrow,
    .section-kicker,
    .platform-code,
    .availability {
      font-size: 12px;
      font-weight: 760;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }

    .eyebrow,
    .section-kicker {
      color: var(--copper-bright);
    }

    h1 {
      max-width: 820px;
      margin: 18px 0 20px;
      font-size: clamp(42px, 6vw, 76px);
      line-height: 0.98;
      letter-spacing: -0.055em;
    }

    .hero-copy {
      max-width: 720px;
      color: #b3c0c7;
      font-size: clamp(16px, 2vw, 19px);
      line-height: 1.65;
    }

    .hero-copy span,
    .install-note span {
      display: block;
      color: #80919b;
    }

    .hero-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 14px;
      margin-top: 30px;
    }

    .jump-download {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 48px;
      padding: 0 20px;
      border-radius: 10px;
      color: #fff8ef;
      background: var(--copper);
      font-weight: 720;
      text-decoration: none;
      box-shadow: 0 10px 30px rgb(189 87 39 / 22%);
      transition: transform 160ms ease, background 160ms ease;
    }

    .jump-download:hover {
      background: #ce6330;
      transform: translateY(-2px);
    }

    .delivery-note {
      color: #81919a;
      font-size: 13px;
    }

    .ledger {
      padding: 26px;
      border: 1px solid var(--ink-700);
      border-radius: var(--radius);
      background: rgb(6 16 26 / 86%);
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
    }

    .ledger dl {
      margin: 18px 0 0;
    }

    .ledger-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 18px;
      padding: 15px 0;
      border-top: 1px solid var(--ink-700);
    }

    .ledger dt {
      color: #7f929d;
      font-size: 13px;
    }

    .ledger dd {
      margin: 0;
      font-size: 13px;
      font-weight: 720;
      text-align: right;
    }

    .platform-nav {
      position: sticky;
      z-index: 10;
      top: 0;
      border-bottom: 1px solid rgb(255 255 255 / 8%);
      background: rgb(6 16 26 / 92%);
      backdrop-filter: blur(18px);
    }

    .platform-rail {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 10px;
      padding: 16px 0;
    }

    .platform-tab {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      min-height: 48px;
      padding: 8px 10px;
      border: 1px solid #1d3343;
      border-radius: 10px;
      color: #9cabb3;
      background: #0a1a28;
      font-size: 13px;
      text-decoration: none;
      transition: border-color 160ms ease, color 160ms ease, background 160ms ease;
    }

    .platform-tab:hover,
    .platform-tab.recommended {
      border-color: var(--copper-bright);
      color: #fff8ef;
      background: var(--copper);
    }

    main {
      color: var(--graphite);
      background: var(--paper);
    }

    .platform-section {
      padding: 72px 0 84px;
    }

    .section-heading {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 30px;
      margin-bottom: 30px;
    }

    h2 {
      margin: 8px 0 0;
      font-size: clamp(30px, 4vw, 48px);
      letter-spacing: -0.045em;
    }

    .section-summary {
      max-width: 440px;
      margin: 0;
      color: var(--muted);
      line-height: 1.55;
      text-align: right;
    }

    .platform-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 16px;
    }

    .platform-card {
      grid-column: span 2;
      display: flex;
      min-height: 350px;
      flex-direction: column;
      padding: 24px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #fffdfa;
      box-shadow: 0 12px 28px rgb(36 45 50 / 5%);
      scroll-margin-top: 96px;
      transition: border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease;
    }

    .platform-card:nth-last-child(-n + 2) {
      grid-column: span 3;
    }

    .platform-card.recommended {
      border-color: var(--copper);
      box-shadow: 0 18px 45px rgb(189 87 39 / 15%);
      transform: translateY(-4px);
    }

    .card-topline {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .platform-code {
      color: var(--copper);
    }

    .availability {
      color: #9b7d6e;
    }

    .availability.available {
      color: #23795f;
    }

    .platform-card h3 {
      margin: 30px 0 4px;
      font-size: 28px;
      letter-spacing: -0.035em;
    }

    .architecture {
      margin: 0;
      color: var(--copper);
      font-size: 13px;
      font-weight: 720;
    }

    .install-note {
      margin: 24px 0;
      color: #394a54;
      font-size: 14px;
      line-height: 1.55;
    }

    .install-note span {
      margin-top: 4px;
      color: #75828a;
    }

    .download-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: auto;
    }

    .download-primary,
    .download-alt {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      border-radius: 9px;
      font-size: 13px;
      font-weight: 720;
      text-decoration: none;
    }

    .download-primary {
      width: 100%;
      padding: 0 16px;
      color: #fff8ef;
      background: var(--copper);
    }

    .download-primary:hover {
      background: #ce6330;
    }

    .download-alt {
      padding: 0 12px;
      border: 1px solid var(--line);
      color: #33444d;
      background: var(--paper);
    }

    .asset-facts {
      margin: 12px 0 0;
      color: #78858c;
      font-size: 12px;
    }

    .asset-facts span {
      margin: 0 5px;
    }

    .unavailable {
      margin-top: auto;
      padding: 16px;
      border: 1px dashed #bea99e;
      border-radius: 10px;
      color: #795b4d;
      background: #f5ede7;
      font-size: 14px;
      font-weight: 720;
    }

    .unavailable span {
      display: block;
      margin-top: 4px;
      color: #947d72;
      font-weight: 500;
    }

    .other-jump {
      display: inline-block;
      margin-top: 12px;
      color: var(--copper);
      font-size: 12px;
      font-weight: 720;
      text-underline-offset: 3px;
    }

    .other-section {
      padding: 68px 0 86px;
      background: var(--paper-deep);
      border-top: 1px solid var(--line);
    }

    .other-list {
      overflow: hidden;
      margin-top: 28px;
      border: 1px solid #d5cfc2;
      border-radius: 12px;
      background: #faf8f2;
    }

    .other-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto 76px;
      gap: 24px;
      align-items: center;
      min-height: 54px;
      padding: 10px 18px;
      border-bottom: 1px solid #ddd8cd;
      color: #30404a;
      font-size: 13px;
      text-decoration: none;
    }

    .other-row:last-child {
      border-bottom: 0;
    }

    .other-row:hover {
      background: #fffdfa;
    }

    .other-name {
      overflow-wrap: anywhere;
    }

    .other-size {
      color: #758188;
      font-variant-numeric: tabular-nums;
    }

    .other-action {
      color: var(--copper);
      font-weight: 720;
      text-align: right;
    }

    .other-empty {
      padding: 24px;
      border: 1px dashed #bcb4a6;
      border-radius: 12px;
      color: var(--muted);
    }

    footer {
      padding: 38px 0;
      color: #9aabb4;
      background: var(--ink-950);
      font-size: 13px;
    }

    .footer-grid {
      display: flex;
      justify-content: space-between;
      gap: 24px;
    }

    .footer-grid strong {
      color: var(--paper);
    }

    noscript p {
      margin: 0;
      padding: 10px 20px;
      color: var(--ink-950);
      background: #ffd7b5;
      text-align: center;
    }

    @media (max-width: 900px) {
      .hero-grid {
        grid-template-columns: 1fr;
      }

      .ledger {
        max-width: 560px;
      }

      .platform-rail {
        grid-template-columns: repeat(5, minmax(110px, 1fr));
        overflow-x: auto;
        scrollbar-width: thin;
      }

      .platform-card,
      .platform-card:nth-last-child(-n + 2) {
        grid-column: span 3;
      }

      .section-heading {
        display: block;
      }

      .section-summary {
        margin-top: 12px;
        text-align: left;
      }
    }

    @media (max-width: 620px) {
      .shell {
        width: min(100% - 28px, 1280px);
      }

      .topbar {
        min-height: 70px;
      }

      .brand span:last-child {
        display: none;
      }

      .mirror-status {
        white-space: normal;
      }

      .hero {
        padding: 52px 0;
      }

      h1 {
        font-size: clamp(38px, 13vw, 58px);
      }

      .platform-nav {
        position: relative;
      }

      .platform-rail {
        margin-inline: -14px;
        padding-inline: 14px;
      }

      .platform-section,
      .other-section {
        padding-block: 52px;
      }

      .platform-card,
      .platform-card:nth-last-child(-n + 2) {
        grid-column: 1 / -1;
      }

      .other-row {
        grid-template-columns: minmax(0, 1fr) auto;
      }

      .other-action {
        display: none;
      }

      .footer-grid {
        flex-direction: column;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      html {
        scroll-behavior: auto;
      }

      *,
      *::before,
      *::after {
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
      }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#downloads">跳到下载 / Skip to downloads</a>
  <header>
    <div class="topbar shell">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <span>CatGo / 下载中心</span>
      </div>
      <div class="mirror-status">中国大陆镜像在线 · Mirror online</div>
    </div>

    <section class="hero">
      <div class="hero-grid shell">
        <div>
          <div class="eyebrow">CATGO RELEASE / ${escapeHtml(model.tag)}</div>
          <h1>最快的 CatGo 下载路径</h1>
          <p class="hero-copy">
            无需登录，不经 GitHub。所有支持平台共享同一个最新发布版本。
            <span>No sign-in. One current release for every supported platform.</span>
          </p>
          <div class="hero-actions">
            <a class="jump-download" href="#downloads">选择平台 · Choose platform ↓</a>
            <span class="delivery-note">Cloudflare R2 · 支持断点续传</span>
          </div>
        </div>

        <aside class="ledger" aria-label="Release status">
          <div class="section-kicker">RELEASE LEDGER / 发布状态</div>
          <dl>
            <div class="ledger-row">
              <dt>Current / 当前版本</dt>
              <dd>${escapeHtml(model.tag)}</dd>
            </div>
            <div class="ledger-row">
              <dt>Platforms / 可用平台</dt>
              <dd>${availableCount} / ${platformList.length}</dd>
            </div>
            <div class="ledger-row">
              <dt>Delivery / 分发</dt>
              <dd>Cloudflare R2</dd>
            </div>
          </dl>
        </aside>
      </div>
    </section>

    <nav class="platform-nav" aria-label="平台快速导航 / Platform navigation">
      <div class="platform-rail shell">
        ${platformList.map(renderPlatformTab).join('')}
      </div>
    </nav>
    <noscript>
      <p>页面无需 JavaScript 即可下载；系统推荐高亮已关闭。 / Downloads remain available without JavaScript.</p>
    </noscript>
  </header>

  <main id="downloads">
    <section class="platform-section">
      <div class="shell">
        <div class="section-heading">
          <div>
            <div class="section-kicker">LATEST INSTALLERS / 最新安装器</div>
            <h2>选择你的平台 / Choose your platform</h2>
          </div>
          <p class="section-summary">
            每个链接都直接读取同一个 R2 镜像对象。签名文件与开发者工具位于下方。
          </p>
        </div>
        <div class="platform-grid">
          ${platformList.map(renderPlatformCard).join('')}
        </div>
      </div>
    </section>

    <section class="other-section" id="other-downloads">
      <div class="shell">
        <div class="section-kicker">RELEASE LEDGER / 发布文件</div>
        <h2>其他下载 / Other downloads</h2>
        ${renderOtherDownloads(model.other)}
      </div>
    </section>
  </main>

  <footer>
    <div class="footer-grid shell">
      <strong>CatGo · Materials workflows, delivered directly.</strong>
      <span>无跟踪 · 无外部 CDN · Cloudflare R2</span>
    </div>
  </footer>

  <script>
    (() => {
      const value = [
        navigator.userAgentData && navigator.userAgentData.platform,
        navigator.platform,
        navigator.userAgent
      ].filter(Boolean).join(' ').toLowerCase();
      let platform = 'windows';
      if (/iphone|ipad|ipod/.test(value)) platform = 'ios';
      else if (/android/.test(value)) platform = 'android';
      else if (/mac/.test(value)) platform = 'macos';
      else if (/linux|x11/.test(value)) platform = 'linux';
      document.querySelectorAll('[data-platform="' + platform + '"]')
        .forEach((node) => node.classList.add('recommended'));
    })();
  </script>
</body>
</html>
`
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid command-line argument near ${key ?? '<end>'}`)
    }
    values[key.slice(2)] = value
  }
  const required = ['assets-dir', 'tag', 'base-url', 'output']
  for (const key of required) {
    if (!values[key]) throw new Error(`Missing required --${key}`)
  }
  return values
}

function runCli(argv) {
  const args = parseArguments(argv)
  const assetsDirectory = resolve(args['assets-dir'])
  const outputPath = resolve(args.output)
  const assets = readdirSync(assetsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = resolve(assetsDirectory, entry.name)
      return {
        name: entry.name,
        size: statSync(path).size,
      }
    })

  const model = buildReleaseModel({
    assets,
    tag: args.tag,
    baseUrl: args['base-url'],
  })
  writeFileSync(outputPath, renderDownloadPage(model), 'utf8')

  const available = Object.values(model.platforms)
    .filter((platform) => platform.available)
    .map((platform) => platform.name)
    .join(', ')
  process.stdout.write(
    `Generated ${basename(outputPath)} for ${model.tag}: ${available}\n`,
  )
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 1
  }
}
