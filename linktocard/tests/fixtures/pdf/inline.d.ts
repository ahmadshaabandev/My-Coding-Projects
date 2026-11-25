// Vite's ?inline imports: the file as a base64 data: URL. Referenced from tests/pdf-helpers.ts.
declare module '*.pdf?inline' {
  const dataUrl: string
  export default dataUrl
}
