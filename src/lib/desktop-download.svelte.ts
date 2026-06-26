// Global visibility for the "download the CatGo desktop app" modal (the OS
// picker + downloader). Opened explicitly by the inline DesktopRequiredNotice
// button — only shown next to the actual "requires the CatGo desktop app" error.

let visible = $state(false)

export const desktop_download = {
  get visible() {
    return visible
  },
  open() {
    visible = true
  },
  close() {
    visible = false
  },
}
