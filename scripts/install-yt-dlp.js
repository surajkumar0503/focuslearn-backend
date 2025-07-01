const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const binDir = path.resolve(__dirname, '../bin');
fs.mkdirSync(binDir, { recursive: true });

const ytDlpPath = path.join(binDir, 'yt-dlp');

try {
  console.log('Downloading yt-dlp binary...');
  execSync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ${ytDlpPath}`, { stdio: 'inherit' });
  fs.chmodSync(ytDlpPath, 0o755);
  console.log('yt-dlp installed to bin/ folder');
} catch (err) {
  console.error('Failed to download yt-dlp:', err);
  process.exit(1);
}