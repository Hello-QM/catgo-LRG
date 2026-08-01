import {
  COMPRESSION_EXTENSIONS,
  COMPRESSION_EXTENSIONS_REGEX,
  COMPRESSION_FORMATS,
} from '$lib/constants'

export type CompressionFormat = keyof typeof COMPRESSION_FORMATS
export type CompressionExtension = (typeof COMPRESSION_EXTENSIONS)[number]

/** Binary structure/trajectory containers that must never pass through a
 * text decoder. Compression suffixes are ignored for routing purposes. */
export function is_binary_structure_filename(filename: string): boolean {
  const base_name = filename.replace(COMPRESSION_EXTENSIONS_REGEX, ``)
  return /\.(traj|h5|hdf5)$/i.test(base_name)
}

export function detect_compression_format(
  filename: string,
): CompressionFormat | null {
  const lower = filename.toLowerCase()
  for (const [format, extensions] of Object.entries(COMPRESSION_FORMATS)) {
    if (extensions.some((ext) => lower.endsWith(ext))) return format as CompressionFormat
  }
  return null
}

export async function decompress_data(
  data: ArrayBuffer | ReadableStream<Uint8Array> | null,
  format: CompressionFormat,
): Promise<string> {
  try {
    // Handle unsupported formats
    if (format === `zip` || format === `xz` || format === `bz2`) {
      throw new Error(
        `${format.toUpperCase()} decompression is not supported in the browser. Please extract the ${format.toUpperCase()} file first.`,
      )
    }

    const stream = data instanceof ArrayBuffer
      ? new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(data))
          controller.close()
        },
      })
      : data
    if (!stream) throw new Error(`Invalid data stream`)
    const unzip = new DecompressionStream(format as `gzip` | `deflate` | `deflate-raw`)
    return await new Response(stream.pipeThrough(unzip)).text()
  } catch (error) {
    throw new Error(`Failed to decompress ${format} file: ${error}`)
  }
}

/** Decompress a binary structure container without converting its bytes to
 * Unicode text. The returned filename has the compression suffix removed so
 * downstream format detection sees `.traj`, `.h5`, or `.hdf5`. */
export async function decompress_binary_structure_data(
  data: ArrayBuffer,
  filename: string,
): Promise<{ content: ArrayBuffer; filename: string }> {
  const format = detect_compression_format(filename)
  if (!format) return { content: data, filename }
  if (format === `zip` || format === `xz` || format === `bz2`) {
    throw new Error(
      `${format.toUpperCase()} decompression is not supported in the browser. Please extract the ${format.toUpperCase()} file first.`,
    )
  }
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(data))
      controller.close()
    },
  })
  const content = await new Response(
    stream.pipeThrough(
      new DecompressionStream(format as `gzip` | `deflate` | `deflate-raw`),
    ),
  ).arrayBuffer()
  return {
    content,
    filename: filename.replace(COMPRESSION_EXTENSIONS_REGEX, ``),
  }
}

/** Formats that must reach the parsers as raw bytes. Reading these as text
 *  garbles the binary irreversibly: an ASE .traj picked in a browser (the
 *  static web deploy has no backend to stream through) hit every text parser
 *  as mojibake and failed with "Unsupported text format" even though a
 *  client-side ulm parser exists (`parse_ase_trajectory`). */
export function decompress_file(
  file: File,
): Promise<{ content: string | ArrayBuffer; filename: string }> {
  const format = detect_compression_format(file.name)
  const is_supported = Boolean(format && ![`zip`, `xz`, `bz2`].includes(format))
  const base_name = file.name.replace(COMPRESSION_EXTENSIONS_REGEX, ``)
  const wants_binary = is_binary_structure_filename(base_name)

  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = async (event) => {
      try {
        const result = event.target?.result
        if (!result) throw new Error(`Failed to read file`)

        if (is_supported && format) {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(result as ArrayBuffer))
              controller.close()
            },
          })
          const unzipped = stream.pipeThrough(
            new DecompressionStream(format as `gzip` | `deflate` | `deflate-raw`),
          )
          const content = wants_binary
            ? await new Response(unzipped).arrayBuffer()
            : await new Response(unzipped).text()
          resolve({ content, filename: base_name })
        } else {
          resolve({ content: result as string | ArrayBuffer, filename: file.name })
        }
      } catch (error) {
        reject(error)
      }
    }

    reader.onerror = () => reject(new Error(`Failed to read file ${file.name}`))

    if (is_supported || wants_binary) reader.readAsArrayBuffer(file)
    else reader.readAsText(file)
  })
}
