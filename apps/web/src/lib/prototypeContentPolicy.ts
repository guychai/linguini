// Enabled in sandbox prototype builds, independently of sandbox egress.
export const restrictGeneratedContent = import.meta.env.VITE_SANDBOX_BOUNDARY === '1';
export function safeGeneratedLink(href: string): string {
  if (/^(?:javascript|data|file|blob|vbscript):/i.test(href.trim()) || href.includes('\\')) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:/i.test(href)) return '';
  return href;
}
