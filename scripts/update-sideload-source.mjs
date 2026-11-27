import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_ICON_URL = 'https://rico-rodriguez.github.io/maestro-ai/icon-1024.png';
export const DEFAULT_SOURCE_URL =
  'https://github.com/Rico-Rodriguez/maestro-ai/releases/latest/download/source.json';
export const DEFAULT_DOWNLOAD_URL =
  'https://github.com/Rico-Rodriguez/maestro-ai/releases/download/ios-v1/MaestroAI.ipa';

const MAX_VERSIONS = 10;

export function buildSideloadSource({
  version,
  buildVersion,
  date = new Date().toISOString(),
  size,
  description = '',
  downloadURL = DEFAULT_DOWNLOAD_URL,
  iconURL = DEFAULT_ICON_URL,
  sourceURL = DEFAULT_SOURCE_URL,
  existingVersions = [],
}) {
  if (!version) {
    throw new Error('version is required');
  }
  if (buildVersion === undefined || buildVersion === null || buildVersion === '') {
    throw new Error('buildVersion is required');
  }
  const resolvedSize = Number(size);
  if (!Number.isFinite(resolvedSize) || resolvedSize < 0) {
    throw new RangeError(`size must be a non-negative finite number, got ${size}`);
  }

  const resolvedVersion = String(version);
  const resolvedBuildVersion = String(buildVersion);
  // Swift ISO8601DateFormatter rejects fractional seconds by default
  const resolvedDate = new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const resolvedDescription = String(description);

  const latestEntry = {
    version: resolvedVersion,
    buildVersion: resolvedBuildVersion,
    date: resolvedDate,
    localizedDescription: resolvedDescription,
    downloadURL,
    size: resolvedSize,
    minOSVersion: '15.0',
  };

  const priorVersions = Array.isArray(existingVersions)
    ? existingVersions.filter((entry) => entry && String(entry.version) !== resolvedVersion)
    : [];
  const versions = [latestEntry, ...priorVersions].slice(0, MAX_VERSIONS);

  return {
    name: 'Maestro AI',
    subtitle: 'Interactive Piano Studio',
    description:
      'Practice sheet music and falling notes with sampled piano audio, MuseScore import, MIDI keyboard, and microphone pitch detection.',
    iconURL,
    sourceURL,
    identifier: 'com.rico.maestroai.source',
    tintColor: '#D97706',
    featuredApps: ['com.rico.maestroai'],
    apps: [
      {
        name: 'Maestro AI',
        bundleIdentifier: 'com.rico.maestroai',
        developerName: 'Rico Rodriguez',
        subtitle: 'Interactive Piano Studio',
        localizedDescription:
          'Practice sheet music and falling notes with sampled concert grand piano audio, MuseScore import, CoreMIDI/Bluetooth MIDI, and YIN microphone pitch detection.',
        iconURL,
        tintColor: '#D97706',
        category: 'music',
        version: resolvedVersion,
        versionDate: resolvedDate,
        versionDescription: resolvedDescription,
        downloadURL,
        size: resolvedSize,
        versions,
        appPermissions: {
          entitlements: [],
          privacy: {
            NSMicrophoneUsageDescription: 'Maestro AI listens to acoustic piano notes.',
            NSBluetoothAlwaysUsageDescription: 'Maestro AI connects to Bluetooth MIDI keyboards.',
          },
        },
      },
    ],
    news: [],
  };
}

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eqIndex = token.indexOf('=');
    if (eqIndex !== -1) {
      args[token.slice(2, eqIndex)] = token.slice(eqIndex + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function main(argv) {
  const args = parseCliArgs(argv);
  if (!args.out) {
    throw new Error('--out is required');
  }

  let size;
  if (args.ipa) {
    size = fs.statSync(args.ipa).size;
  } else if (args.size !== undefined) {
    size = Number(args.size);
  } else {
    throw new Error('Either --ipa or --size is required');
  }

  let existingVersions = [];
  if (args.existing) {
    const existingPath = path.resolve(args.existing);
    if (fs.existsSync(existingPath)) {
      const existingSource = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
      const prior = existingSource?.apps?.[0]?.versions;
      if (Array.isArray(prior)) {
        existingVersions = prior;
      }
    }
  }

  const source = buildSideloadSource({
    version: args.version,
    buildVersion: args.build,
    date: args.date ?? new Date().toISOString(),
    size,
    description: args.notes ?? '',
    downloadURL: args['download-url'] ?? DEFAULT_DOWNLOAD_URL,
    iconURL: args['icon-url'] ?? DEFAULT_ICON_URL,
    sourceURL: args['source-url'] ?? DEFAULT_SOURCE_URL,
    existingVersions,
  });

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(source, null, 2)}\n`, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
