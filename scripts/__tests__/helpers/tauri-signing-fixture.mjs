import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'

function rawEd25519PublicKey(publicKey) {
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  return spki.subarray(spki.length - 32)
}

export function createTauriSigningFixture(sourceRoot) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyId = randomBytes(8)
  const publicKeyPacket = Buffer.concat([
    Buffer.from('Ed'),
    keyId,
    rawEd25519PublicKey(publicKey),
  ])
  const publicKeyText = [
    `untrusted comment: minisign public key: ${Buffer.from(keyId).reverse().toString('hex').toUpperCase()}`,
    publicKeyPacket.toString('base64'),
    '',
  ].join('\n')
  const updaterPubkey = Buffer.from(publicKeyText).toString('base64')

  mkdirSync(resolve(sourceRoot, 'src-tauri'), { recursive: true })
  writeFileSync(
    resolve(sourceRoot, 'src-tauri/tauri.conf.json'),
    `${JSON.stringify({
      plugins: {
        updater: {
          pubkey: updaterPubkey,
        },
      },
    })}\n`,
  )

  return {
    signArtifact(path) {
      const artifact = readFileSync(path)
      const primary = sign(
        null,
        createHash('blake2b512').update(artifact).digest(),
        privateKey,
      )
      const trustedComment = 'trusted comment: timestamp:0\tfile:fixture'
      const globalSignature = sign(
        null,
        Buffer.concat([
          primary,
          Buffer.from(trustedComment.slice('trusted comment: '.length)),
        ]),
        privateKey,
      )
      const signatureText = [
        'untrusted comment: signature from minisign secret key',
        Buffer.concat([Buffer.from('ED'), keyId, primary]).toString('base64'),
        trustedComment,
        globalSignature.toString('base64'),
        '',
      ].join('\n')
      return Buffer.from(signatureText).toString('base64')
    },
    updaterPubkey,
  }
}

export function tamperInlineTauriSignature(signature) {
  const signatureText = Buffer.from(signature, 'base64').toString('utf8')
  const lines = signatureText.trimEnd().split('\n')
  const packet = Buffer.from(lines[1], 'base64')
  packet[packet.length - 1] ^= 1
  lines[1] = packet.toString('base64')
  return Buffer.from(`${lines.join('\n')}\n`).toString('base64')
}
