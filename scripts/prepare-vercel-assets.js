const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function prepareVercelAssets(outputDirectory = path.join(projectRoot, 'public')) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const page of ['index.html', 'signup.html', 'about.html', 'logistics.html']) {
    fs.copyFileSync(path.join(projectRoot, page), path.join(outputDirectory, page));
  }
  copyDirectory(path.join(projectRoot, 'assets'), path.join(outputDirectory, 'assets'));
}

if (require.main === module) {
  prepareVercelAssets(process.env.VERCEL_PUBLIC_DIR || undefined);
}

module.exports = { prepareVercelAssets };
