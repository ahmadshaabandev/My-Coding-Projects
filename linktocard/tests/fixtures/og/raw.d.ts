// Vite's ?raw imports: the file's text. Referenced from tests/inspect*.test.ts.
declare module '*.html?raw' {
  const text: string
  export default text
}
