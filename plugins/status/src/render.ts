import { initWasm, Resvg } from '@resvg/resvg-wasm'

let ready: Promise<void> | undefined
async function initialize() {
  if (!ready) {
    ready = (async () => {
      await initWasm(await Bun.file(new URL('../assets/renderer.wasm', import.meta.url)).arrayBuffer())
    })()
  }
  await ready
}
export async function renderCard(svg: string) {
  await initialize()
  const font = new Uint8Array(
    await Bun.file(new URL('../assets/DejaVuSans.ttf', import.meta.url)).arrayBuffer()
  )
  const renderer = new Resvg(svg, { font: { fontBuffers: [font], defaultFontFamily: 'DejaVu Sans' } })
  try {
    const rendered = renderer.render()
    try {
      return rendered.asPng()
    } finally {
      rendered.free()
    }
  } finally {
    renderer.free()
  }
}
