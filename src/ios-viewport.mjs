export function iosIndexHtml(html) {
  return html.replace(
    'width=device-width, initial-scale=1.0',
    'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover',
  );
}
