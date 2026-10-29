import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// True when the module at `moduleUrl` (its import.meta.url) is the script node
// was started with, false when it was imported. Node resolves import.meta.url
// to the real path while process.argv[1] keeps the path as typed, so a script
// reached through a symlink (a plugin directory linked into place) is compared
// by its real path. No argv[1] (a REPL, `node -e`) or one that does not
// resolve means the module was not started directly.
export function isMain(moduleUrl) {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}
