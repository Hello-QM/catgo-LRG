#!/usr/bin/env node
/**
 * Generate Tauri app icons from logo.png
 *
 * Usage: node scripts/generate-icons.js
 *
 * Prerequisites:
 *   npm install sharp png2icons --save-dev
 */

import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const ICONS_DIR = join(ROOT, 'src-tauri', 'icons')
// Use PNG logo as the primary source
const LOGO_PATH = join(ROOT, 'desktop', 'logo.png')
// Fallback to SVG if PNG doesn't exist
const SVG_PATH = join(ROOT, 'static', 'favicon.svg')

// Icon sizes needed for Tauri
const SIZES = {
  // macOS
  '32x32.png': 32,
  '128x128.png': 128,
  '128x128@2x.png': 256,
  'icon.png': 512,

  // Windows Store logos
  'Square30x30Logo.png': 30,
  'Square44x44Logo.png': 44,
  'Square71x71Logo.png': 71,
  'Square89x89Logo.png': 89,
  'Square107x107Logo.png': 107,
  'Square142x142Logo.png': 142,
  'Square150x150Logo.png': 150,
  'Square284x284Logo.png': 284,
  'Square310x310Logo.png': 310,
  'StoreLogo.png': 50,
}

async function main() {
  // Check if sharp is installed
  let sharp
  try {
    sharp = (await import('sharp')).default
  } catch {
    console.log('Installing sharp...')
    execSync('npm install sharp --save-dev', { cwd: ROOT, stdio: 'inherit' })
    sharp = (await import('sharp')).default
  }

  // Check if png2icons is available for .ico and .icns
  let png2icons
  try {
    png2icons = await import('png2icons')
  } catch {
    console.log('Installing png2icons...')
    execSync('npm install png2icons --save-dev', { cwd: ROOT, stdio: 'inherit' })
    png2icons = await import('png2icons')
  }

  // Determine source image (prefer PNG, fallback to SVG)
  let sourcePath
  let sourceType
  if (existsSync(LOGO_PATH)) {
    sourcePath = LOGO_PATH
    sourceType = 'png'
    console.log(`Using PNG logo: ${LOGO_PATH}`)
  } else if (existsSync(SVG_PATH)) {
    sourcePath = SVG_PATH
    sourceType = 'svg'
    console.log(`Using SVG fallback: ${SVG_PATH}`)
  } else {
    console.error(`No source image found. Expected: ${LOGO_PATH} or ${SVG_PATH}`)
    process.exit(1)
  }

  if (!existsSync(ICONS_DIR)) {
    mkdirSync(ICONS_DIR, { recursive: true })
  }

  const sourceBuffer = readFileSync(sourcePath)

  console.log('Generating PNG icons...')

  // Generate all PNG sizes
  for (const [filename, size] of Object.entries(SIZES)) {
    const outputPath = join(ICONS_DIR, filename)
    await sharp(sourceBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath)
    console.log(`  Created ${filename} (${size}x${size})`)
  }

  // Generate .ico for Windows
  console.log('Generating Windows icon (icon.ico)...')
  const icon256 = await sharp(sourceBuffer).resize(256, 256).png().toBuffer()
  const icoBuffer = png2icons.createICO(icon256, png2icons.BILINEAR, 0, true, true)
  writeFileSync(join(ICONS_DIR, 'icon.ico'), icoBuffer)
  console.log('  Created icon.ico')

  // Generate .icns for macOS
  console.log('Generating macOS icon (icon.icns)...')
  const icon1024 = await sharp(sourceBuffer).resize(1024, 1024).png().toBuffer()
  const icnsBuffer = png2icons.createICNS(icon1024, png2icons.BILINEAR, 0)
  writeFileSync(join(ICONS_DIR, 'icon.icns'), icnsBuffer)
  console.log('  Created icon.icns')

  console.log('\nDone! Icons generated in src-tauri/icons/')
}

main().catch(console.error)
