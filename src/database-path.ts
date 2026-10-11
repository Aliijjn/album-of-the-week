import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const filenames = ['album-of-the-week.sqlite', 'aotw.sqlite'];

function contained(path: string, directory: string): boolean {
  const child = relative(directory, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

// Resolve existing ancestors too, so symlinked directories cannot bypass the volume check.
function physicalPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) return path;
  return resolve(physicalPath(parent), relative(parent, path));
}

export function databasePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  const railway = Boolean(mount || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID || env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_DEPLOYMENT_ID);
  if (railway && !mount) {
    throw new Error('Railway requires a persistent volume for SQLite. Attach the existing volume to this service at /app/data. Refusing to create a database on temporary storage.');
  }
  if (mount && (!isAbsolute(mount) || !existsSync(mount) || !statSync(mount).isDirectory())) {
    throw new Error('The Railway volume mount is unavailable. Check the volume attachment and mount path before starting the bot.');
  }
  const configured = env.DATABASE_PATH?.trim();
  if (configured === ':memory:') throw new Error('DATABASE_PATH must be a persistent file, not :memory:.');
  const directory = mount ? resolve(mount) : resolve(cwd, 'data');
  const candidates = filenames.map(name => join(directory, name)).filter(existsSync);
  let path: string;
  if (configured) {
    path = resolve(cwd, configured);
  } else {
    if (candidates.length > 1) throw new Error(`Multiple database files exist. Set DATABASE_PATH to the database you want to use: ${candidates.join(', ')}.`);
    path = candidates[0] ?? join(directory, filenames[0]!);
  }
  if (mount && !contained(physicalPath(path), realpathSync(mount))) {
    throw new Error(`DATABASE_PATH (${path}) must be inside the Railway volume (${mount}). Refusing to use temporary storage. Keep the existing database filename when correcting this path.`);
  }
  if (!existsSync(path)) {
    const alternatives = [...new Set([...candidates, ...filenames.map(name => join(dirname(path), name)).filter(existsSync)])];
    if (alternatives.length) {
      throw new Error(`Configured database is missing: ${path}. Existing database found at ${alternatives.join(', ')}. Correct DATABASE_PATH; refusing to create an empty replacement.`);
    }
  } else if (!statSync(path).isFile()) {
    throw new Error(`DATABASE_PATH must point to a SQLite file: ${path}.`);
  }
  return path;
}
