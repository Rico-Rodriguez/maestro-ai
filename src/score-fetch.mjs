import { SCORE_ORIGIN } from '../shared/musescore-contract.mjs';

export function shouldUseNativeScoreFetch(input, pageHref, scoreOrigin = SCORE_ORIGIN) {
  const raw = typeof input === 'string' ? input : input && input.url;
  if (typeof raw !== 'string' || !raw) return false;
  let absolute;
  let page;
  try {
    page = new URL(pageHref);
    absolute = new URL(raw, page);
  } catch {
    return false;
  }
  if (absolute.origin === page.origin) return false;
  try {
    return absolute.origin === new URL(scoreOrigin).origin;
  } catch {
    return false;
  }
}

export function nativeHttpToResponse(native) {
  const headers = new Headers();
  const source = native && native.headers;
  if (source && typeof source === 'object') {
    Object.entries(source).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((item) => headers.append(key, String(item)));
      } else if (value != null) {
        headers.set(key, String(value));
      }
    });
  }
  let body = native ? native.data : '';
  if (body == null) body = '';
  else if (typeof body !== 'string') body = JSON.stringify(body);
  const status = Number(native && native.status) || 0;
  return new Response(body, { status, headers });
}
