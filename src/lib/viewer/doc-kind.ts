export type DocKind = 'text' | 'markdown' | 'csv' | 'pdf' | 'image' | 'excel' | 'docx' | 'html'
export type PreviewMode = 'image' | 'pdf' | 'markdown' | 'csv' | 'excel' | 'text'

export interface DocKindInfo {
  kind: DocKind
  editable: boolean
  preview_mode: PreviewMode | null
}

const IMAGE = /\.(png|jpe?g|gif|bmp|webp|svg|ico|tiff?)$/i
const EXCEL = /\.(xlsx?|xlsm|xlsb|ods)$/i
const CSV = /\.(csv|tsv)$/i
const MD = /\.(md|markdown|rst)$/i

export function resolve_doc_kind(filename: string, _mime?: string): DocKindInfo {
  const name = filename.toLowerCase()
  if (IMAGE.test(name)) return { kind: 'image', editable: false, preview_mode: 'image' }
  if (/\.pdf$/i.test(name)) return { kind: 'pdf', editable: false, preview_mode: 'pdf' }
  if (EXCEL.test(name)) return { kind: 'excel', editable: false, preview_mode: 'excel' }
  if (CSV.test(name)) return { kind: 'csv', editable: false, preview_mode: 'csv' }
  if (MD.test(name)) return { kind: 'markdown', editable: true, preview_mode: 'markdown' }
  if (/\.docx?$/i.test(name)) return { kind: 'docx', editable: false, preview_mode: null }
  if (/\.(html?|xhtml)$/i.test(name)) return { kind: 'html', editable: true, preview_mode: null }
  // Everything else (txt, source code, unknown) → editable plain text in Monaco.
  return { kind: 'text', editable: true, preview_mode: null }
}
