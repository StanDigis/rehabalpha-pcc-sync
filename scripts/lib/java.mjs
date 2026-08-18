import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const MINIMUM_MAJOR = 21;

function majorOf(versionString) {
  const match = /(\d+)/.exec(versionString);
  return match ? Number(match[1]) : 0;
}

function majorOfJavaHome(javaHome) {
  const binary = `${javaHome}/bin/java`;
  if (!existsSync(binary)) return 0;

  try {
    // `java -version` writes to stderr on every JDK, hence the stdio redirect.
    const output = execFileSync(binary, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return majorOf(String(output));
  } catch (error) {
    if (error && typeof error === 'object' && 'stderr' in error) {
      return majorOf(String(error.stderr));
    }
    return 0;
  }
}

function candidatesFromJavaHomeTool() {
  if (process.platform !== 'darwin') return [];

  try {
    const output = execFileSync('/usr/libexec/java_home', ['-V'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseJavaHomeOutput(String(output));
  } catch (error) {
    if (error && typeof error === 'object' && 'stderr' in error) {
      return parseJavaHomeOutput(String(error.stderr));
    }
    return [];
  }
}

function parseJavaHomeOutput(text) {
  return text
    .split('\n')
    .map((line) => /"\s*(\/.*?)\s*$/.exec(line)?.[1])
    .filter((path) => typeof path === 'string' && path.length > 0);
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
