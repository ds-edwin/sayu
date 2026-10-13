// Drop auth fragments and query strings; retain the GitHub Pages repository path.
export function appBaseUrl(href = window.location.href): string {
  return new URL("./", href).href;
}
