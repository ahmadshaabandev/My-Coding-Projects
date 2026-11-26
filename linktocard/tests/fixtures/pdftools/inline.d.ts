// Vite's ?inline imports: the file as a base64 data: URL. Referenced from tests/pdftools-helpers.ts.
declare module '*.png?inline' {
  const dataUrl: string
  export default dataUrl
}
declare module '*.jpg?inline' {
  const dataUrl: string
  export default dataUrl
}
