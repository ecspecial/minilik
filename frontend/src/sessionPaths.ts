/**
 * Бэкенд отдаёт пути вида `/sessions/…`; axios с baseURL `/api` ожидает `/api/sessions/…`.
 */
export function sessionAssetRequestPath(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  const u = url.trim();
  if (u.startsWith('/api')) return u;
  if (u.startsWith('/')) return `/api${u}`;
  return u;
}

/** Для скачиваемого JSON — абсолютные URL картинок. */
export function exportedImageUrlField(im: { url?: string }): string | undefined {
  if (!im.url) return undefined;
  if (/^https?:\/\//i.test(im.url)) return im.url;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const path = im.url.startsWith('/api')
    ? im.url
    : `/api${im.url.startsWith('/') ? im.url : `/${im.url}`}`;
  return `${origin}${path}`;
}
