import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const MINIMUM_MAJOR = 21;

/**
 * Both `java -version` and `/usr/libexec/java_home -V` write to stderr and exit zero, which is why
 * this uses `spawnSync` and reads both streams. Reading only stdout returns an empty string, and the
 * version parse then silently yields 0 — a JDK 22 install reported as "no JDK found".
 */
function runCapturingBothStreams(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function majorOf(versionString) {
  const match = /(\d+)/.exec(versionString);
  return match ? Number(match[1]) : 0;
}

function majorOfJavaHome(javaHome) {
  const binary = `${javaHome}/bin/java`;
  if (!existsSync(binary)) return 0;

  return majorOf(runCapturingBothStreams(binary, ['-version']));
}

function candidatesFromJavaHomeTool() {
  if (process.platform !== 'darwin') return [];

  if (!existsSync('/usr/libexec/java_home')) return [];
  return parseJavaHomeOutput(runCapturingBothStreams('/usr/libexec/java_home', ['-V']));
}

/** Pulls the install paths out of `java_home -V`, which lists one JDK per line. */
function parseJavaHomeOutput(text) {
  return text
    .split('\n')
    .map((line) => /\s(\/\S.*?)\s*$/.exec(line)?.[1])
    .filter((path) => typeof path === 'string' && path.startsWith('/'));
}

/**
 * The Firestore emulator refuses to start on JDK < 21, and the failure surfaces as an
 * opaque emulator crash. Resolving a suitable JDK up front turns that into a clear message.
 */
export function resolveJavaHome() {
  const fromEnv = process.env.JAVA_HOME;
  if (fromEnv && majorOfJavaHome(fromEnv) >= MINIMUM_MAJOR) {
    return fromEnv;
  }

  const candidates = [
    ...candidatesFromJavaHomeTool(),
    '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
    '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
    '/usr/lib/jvm/default-java',
  ];

  for (const candidate of candidates) {
    if (majorOfJavaHome(candidate) >= MINIMUM_MAJOR) {
      return candidate;
    }
  }

  const detected = fromEnv ? `JAVA_HOME=${fromEnv} (major ${majorOfJavaHome(fromEnv)})` : 'none';
  throw new Error(
    [
      `The Firebase Firestore emulator requires a JDK ${MINIMUM_MAJOR}+; none was found (${detected}).`,
      'Install one, then re-run:',
      '  macOS:  brew install openjdk@21',
      '  Ubuntu: sudo apt-get install -y openjdk-21-jdk-headless',
      'Or set JAVA_HOME to an existing JDK 21+ installation.',
    ].join('\n'),
  );
}
