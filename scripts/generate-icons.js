// One-off icon generation from assets/logo.png. Run with: node scripts/generate-icons.js
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'assets', 'logo.png');
const BG = { r: 8, g: 29, b: 70, alpha: 1 };

async function main() {
  const src = sharp(SRC);
  const meta = await src.metadata();
  const side = Math.max(meta.width, meta.height);

  const squared = sharp(SRC).resize(meta.width, meta.height).extend({
    top: Math.floor((side - meta.height) / 2),
    bottom: Math.ceil((side - meta.height) / 2),
    left: Math.floor((side - meta.width) / 2),
    right: Math.ceil((side - meta.width) / 2),
    background: BG,
  });

  const squaredBuffer = await squared.png().toBuffer();

  fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
  fs.mkdirSync(path.join(__dirname, '..', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(__dirname, '..', 'src', 'renderer', 'assets'), { recursive: true });

  await sharp(squaredBuffer).resize(1024, 1024).toFile(path.join(__dirname, '..', 'build', 'icon.png'));
  await sharp(squaredBuffer).resize(256, 256).toFile(path.join(__dirname, '..', 'assets', 'icon.png'));
  await sharp(squaredBuffer).resize(128, 128).toFile(path.join(__dirname, '..', 'src', 'renderer', 'assets', 'logo.png'));

  console.log('Icons generated.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
