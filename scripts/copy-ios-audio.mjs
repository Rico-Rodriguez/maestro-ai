// The GitHub Pages build does not ship the grand. The iOS bundle does.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'ios', 'audio', 'grand');
const to = path.join(root, 'dist', 'audio', 'grand');
fs.mkdirSync(path.dirname(to), { recursive: true });
fs.cpSync(from, to, { recursive: true });
