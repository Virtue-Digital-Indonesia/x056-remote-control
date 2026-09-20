import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
export interface MessageImage { name: string; type: string; url: string }
const types: Record<string,string> = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif' };
const mime = (name: string) => types[name.split('.').pop()?.toLowerCase() || ''];
/** Only explicit upload/saved-attachment blocks; arbitrary paths in prose are
 * not permission to expose a filesystem file. No binary reads during history. */
export function messageImages(text: string, fileBase: (owner: string) => string): MessageImage[] {
  const images: MessageImage[] = [];
  for (const block of text.slice(0, 1000000).matchAll(/\[(?:The user attached|Attached saved files\.)[^\]]*\]/g)) {
    for (const m of block[0].matchAll(/\/uploads\/([a-f0-9-]{36})\/([^\n\]]+?\.(?:png|jpe?g|webp|gif))(?=[\]\n]|$)/gi)) {
      images.push({ name: m[2], type: mime(m[2]), url: '/api/conversations/upload-image?upload=' + encodeURIComponent(m[1]) + '&name=' + encodeURIComponent(m[2]) });
    }
    for (const m of block[0].matchAll(/^- ("(?:[^"\\]|\\.)+") \(ownerId=([\w-]+), fileId=([\w-]+), versionId=([\w-]+),/gm)) {
      let name: string; try { name = JSON.parse(m[1]); } catch { continue; }
      if (mime(name)) images.push({ name, type: mime(name), url: fileBase(m[2]) + '/files/' + encodeURIComponent(m[3]) + '/versions/' + encodeURIComponent(m[4]) + '/content' });
    }
  }
  return [...new Map(images.map(i => [i.url, i])).values()].slice(0, 30);
}
export function uploadImage(state: string, upload: string, name: string) {
  if (!/^[a-f0-9-]{36}$/i.test(upload) || !name || /[/\\\x00-\x1f]/.test(name) || !mime(name)) throw new Error('Invalid image reference');
  const root = realpathSync(join(state, 'uploads'));
  const path = join(root, upload, name);
  if (realpathSync(path) !== path || !statSync(path).isFile() || statSync(path).size > 50 * 1024 * 1024) throw new Error('Image unavailable');
  return { path, type: mime(name) };
}
