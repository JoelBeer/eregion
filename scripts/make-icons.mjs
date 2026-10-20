// Renders the app icon (the anvil from the sidebar logo) to PNGs: build/icon.png for the window
// and installers, and build/icons/<size>x<size>.png for Linux desktops. Run: npm run icons
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 28 28">
  <rect width="28" height="28" rx="6.5" fill="#76E1EF"/>
  <path d="M3 9.5H24V13H19.5L17.5 15.5V18H20.5V21H7.5V18H10.5V15.5L9 13.5Q5.5 13 3 9.5Z" fill="#06304A"/>
  <circle cx="21.5" cy="5.5" r="1.5" fill="#C9F0F6"/>
  <circle cx="18" cy="4.5" r="1" fill="#C9F0F6"/>
</svg>`

await mkdir(join(root, 'build', 'icons'), { recursive: true })
await sharp(Buffer.from(svg)).resize(512, 512).png().toFile(join(root, 'build', 'icon.png'))
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png()
    .toFile(join(root, 'build', 'icons', `${size}x${size}.png`))
}
console.log('Wrote build/icon.png and build/icons/')
