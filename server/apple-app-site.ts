/**
 * Apple App Site Association for the native iOS app (ios/).
 *
 * iOS offers this site's passkeys to an app only when this file lists the
 * app's FULL signed application identifier (team id + bundle id) under
 * `webcredentials`, and the app carries `webcredentials:<this host>`.
 * iPhones read the file through Apple's CDN, which caches it for up to 6 h,
 * so a change here reaches a device late, and only an install or update made
 * after Apple re-fetched it sees the new list.
 *
 * X056_IOS_APP_IDS (comma-separated) replaces the default list.
 */
export const DEFAULT_IOS_APP_IDS = ['Z4NCYN9LKJ.id.val.x056'];

export function appleAppSiteAssociation(env: NodeJS.ProcessEnv = process.env): { webcredentials: { apps: string[] } } {
  const configured = (env.X056_IOS_APP_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { webcredentials: { apps: configured.length ? configured : DEFAULT_IOS_APP_IDS } };
}
